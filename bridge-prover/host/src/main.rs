//! Bridge host: preflight the `Shielded` event query on Base Sepolia, build the Steel input, and
//! either EXECUTE the guest (fast journal-only check) or PROVE it into a Groth16 receipt and emit
//! the router-ready `seal` + `journal` artifacts that Stellar `shield_from_base` consumes.
//!
//! Execute only (needs a real Shielded event on-chain — deploy via `evm/` and shield first):
//!   RPC_URL=https://sepolia.base.org RUST_LOG=info \
//!     cargo run --release -- --bridge 0x<MosaicBridge> --deposit-id 0
//!
//! Prove (Groth16) and write out/{seal.hex,journal.hex}:
//!   RPC_URL=... RUST_LOG=info cargo run --release -- --bridge 0x.. --deposit-id 0 --prove
//!
//! Local Groth16 proving needs the RISC Zero prover stack (`r0vm` / Docker on Apple Silicon, or
//! `RISC0_PROVER=bonsai`). The emitted `seal` is byte-for-byte what the Boundless marketplace
//! returns and what the Nethermind verifier router (and thus `shield_from_base`) accepts — see
//! `bridge-prover/README.md` for the Boundless production path.

use std::{fs, path::PathBuf, sync::LazyLock};

use alloy_primitives::{hex, Address, B256, U256};
use alloy_sol_types::{sol, SolEvent, SolValue};
use anyhow::{Context, Result};
use bridge_methods::{BRIDGE_GUEST_ELF, BRIDGE_GUEST_ID};
use clap::Parser;
use risc0_steel::{
    config::ChainSpec, ethereum::EthChainSpec, ethereum::EthEvmEnv,
    revm::primitives::hardfork::SpecId, Commitment, Event,
};
use risc0_zkvm::{default_executor, default_prover, ExecutorEnv, ProverOpts};
use tokio::task;
use tracing_subscriber::EnvFilter;
use url::Url;

/// Base Sepolia. MUST stay identical to the guest so the committed `configID` matches.
const BASE_SEPOLIA_CHAIN_ID: u64 = 84532;
static BASE_SEPOLIA_CHAIN_SPEC: LazyLock<EthChainSpec> =
    LazyLock::new(|| ChainSpec::new_single(BASE_SEPOLIA_CHAIN_ID, SpecId::PRAGUE));

sol! {
    /// MUST match `MosaicBridge.sol` and the guest exactly.
    #[derive(Debug)]
    interface MosaicBridge {
        event Shielded(
            uint64 indexed depositId,
            uint32 indexed assetId,
            uint256 amount,
            bytes32 ownerTag,
            address token,
            address from
        );
    }
}

sol! {
    /// ABI-encodable journal. MUST match the guest and the Stellar parser (WS4).
    struct Journal {
        Commitment commitment;
        address bridgeAddress;
        uint64 depositId;
        uint32 assetId;
        uint256 amount;
        bytes32 ownerTag;
    }
}

#[derive(Parser, Debug)]
#[command(about, long_about = None)]
struct Args {
    /// URL of the Base Sepolia RPC endpoint.
    #[arg(short, long, env = "RPC_URL")]
    rpc_url: Url,

    /// Deployed MosaicBridge contract address.
    #[arg(short, long, env = "BRIDGE_ADDRESS")]
    bridge: Address,

    /// The deposit id (indexed) of the Shielded event to prove.
    #[arg(short, long)]
    deposit_id: u64,

    /// Produce a Groth16 receipt and write the router-ready seal + journal (otherwise execute only).
    #[arg(long)]
    prove: bool,

    /// Directory for the emitted `seal.hex` / `journal.hex` artifacts when `--prove` is set.
    #[arg(long, default_value = "out")]
    out_dir: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();
    let args = Args::parse();

    // EVM environment from the RPC, defaulting to the latest block.
    let mut env = EthEvmEnv::builder()
        .rpc(args.rpc_url)
        .chain_spec(&BASE_SEPOLIA_CHAIN_SPEC)
        .build()
        .await?;

    // Preflight the event query (same filter the guest applies) to prepare the guest input.
    let deposit_topic = B256::from(U256::from(args.deposit_id));
    let event = Event::preflight::<MosaicBridge::Shielded>(&mut env);
    let logs = event.address(args.bridge).topic1(deposit_topic).query().await?;
    log::info!(
        "Bridge {} emitted {} Shielded event(s) for depositId {} (sig: {})",
        args.bridge,
        logs.len(),
        args.deposit_id,
        MosaicBridge::Shielded::SIGNATURE,
    );
    anyhow::ensure!(
        logs.len() == 1,
        "expected exactly one Shielded event for depositId {}, found {}",
        args.deposit_id,
        logs.len()
    );

    let evm_input = env.into_input().await?;
    let bridge_bytes: [u8; 20] = args.bridge.into();
    let deposit_id = args.deposit_id;
    let do_prove = args.prove;

    // Execute (journal only) or prove (Groth16 receipt -> router-ready seal). Returns the journal
    // bytes and, when proving, the encoded seal.
    let (journal_bytes, seal): (Vec<u8>, Option<Vec<u8>>) = task::spawn_blocking(move || {
        let env = ExecutorEnv::builder()
            .write(&evm_input)
            .context("failed to write evm input")?
            .write(&bridge_bytes)
            .context("failed to write bridge address")?
            .write(&deposit_id)
            .context("failed to write deposit id")?
            .build()
            .context("failed to build env")?;

        if do_prove {
            // Groth16 receipt: the seal verifies on Stellar via the Nethermind router.
            let receipt = default_prover()
                .prove_with_opts(env, BRIDGE_GUEST_ELF, &ProverOpts::groth16())
                .context("failed to prove guest")?
                .receipt;
            receipt
                .verify(BRIDGE_GUEST_ID)
                .context("receipt failed local verification")?;
            let seal = risc0_ethereum_contracts::encode_seal(&receipt)
                .context("failed to encode seal")?;
            Ok::<_, anyhow::Error>((receipt.journal.bytes, Some(seal)))
        } else {
            let info = default_executor()
                .execute(env, BRIDGE_GUEST_ELF)
                .context("failed to run executor")?;
            Ok((info.journal.bytes, None))
        }
    })
    .await??;

    let journal = Journal::abi_decode(&journal_bytes).context("failed to decode journal")?;
    log::debug!("Steel commitment: {:?}", journal.commitment);
    log::info!(
        "Shielded: depositId={} assetId={} amount={} ownerTag={} (bridge {}, block digest {})",
        journal.depositId,
        journal.assetId,
        journal.amount,
        journal.ownerTag,
        journal.bridgeAddress,
        journal.commitment.digest,
    );

    if let Some(seal) = seal {
        // `shield_from_base(seal, journal)` on Stellar consumes exactly these two artifacts (it
        // computes the sha256 journal digest itself).
        fs::create_dir_all(&args.out_dir).context("failed to create out dir")?;
        let journal_path = args.out_dir.join("journal.hex");
        let seal_path = args.out_dir.join("seal.hex");
        fs::write(&journal_path, hex::encode(&journal_bytes))?;
        fs::write(&seal_path, hex::encode(&seal))?;
        log::info!(
            "Wrote {} ({} journal bytes) and {} ({} seal bytes)",
            journal_path.display(),
            journal_bytes.len(),
            seal_path.display(),
            seal.len(),
        );
    }

    Ok(())
}

#[cfg(test)]
mod fixture {
    //! Emits ground-truth values for the Stellar WS4 tests: the ABI-encoded journal byte layout,
    //! the guest image id, and the Base Sepolia config digest. Run with:
    //!   cargo test -p host --release -- --nocapture print_journal_fixture
    use super::{Journal, BASE_SEPOLIA_CHAIN_SPEC};
    use alloy_primitives::{hex, Address, B256, U256};
    use alloy_sol_types::SolValue;
    use bridge_methods::BRIDGE_GUEST_ID;
    use risc0_steel::Commitment;
    use risc0_zkvm::sha::Digest;

    #[test]
    fn print_journal_fixture() {
        let commitment = Commitment {
            id: U256::from(0x1234u64), // version 0 (Block) in top bits, blockNumber = 0x1234
            digest: B256::repeat_byte(0x11),
            configID: B256::repeat_byte(0x22),
        };
        let journal = Journal {
            commitment,
            bridgeAddress: Address::from([0xABu8; 20]),
            depositId: 7,
            assetId: 1,
            amount: U256::from(100_000_000u64), // 100 USDC (6 dp)
            ownerTag: B256::repeat_byte(0x33),
        };
        let enc = journal.abi_encode();
        println!("JOURNAL_LEN={}", enc.len());
        println!("JOURNAL_HEX={}", hex::encode(&enc));

        let image_id = Digest::from(BRIDGE_GUEST_ID);
        println!("IMAGE_ID_HEX={}", hex::encode(image_id.as_bytes()));
        println!("CONFIG_DIGEST_HEX={}", hex::encode(BASE_SEPOLIA_CHAIN_SPEC.digest()));
    }
}
