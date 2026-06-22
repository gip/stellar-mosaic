//! Bridge host: read the Base `MosaicBridge` deposit record via a Steel state proof, and either
//! EXECUTE the guest (fast journal-only check) or PROVE it into a Groth16 receipt and emit the
//! router-ready `seal` + `journal` artifacts that Stellar `shield_from_base` consumes.
//!
//! Base is an OP-stack chain, so this uses risc0-op-steel and proves from CONTRACT STATE (a
//! `deposits(depositId)` view call, via `eth_getProof`) — event/receipt proofs don't work on OP
//! (every block carries a type-0x7e deposit tx the Ethereum receipt decoder rejects).
//!
//! Execute only:
//!   RPC_URL=<base sepolia rpc> RUST_LOG=info \
//!     cargo run --release -- --bridge 0x<MosaicBridge> --deposit-id 1 --block <N>
//!
//! Prove (Groth16) and write out/{seal.hex,journal.hex,seal.bin,journal.bin}:
//!   RPC_URL=... RUST_LOG=info cargo run --release -- --bridge 0x.. --deposit-id 1 --block <N> --prove
//!
//! Local Groth16 proving needs the RISC Zero prover stack (`r0vm`/Docker, or `RISC0_PROVER=bonsai`).
//! The emitted `seal` is what the Boundless marketplace returns and what the Nethermind verifier
//! router (and thus `shield_from_base`) accepts — see `bridge-prover/README.md`.

use std::{fs, path::PathBuf};

use alloy_primitives::{hex, Address};
use alloy_sol_types::{sol, SolValue};
use anyhow::{Context, Result};
use bridge_methods::{BRIDGE_GUEST_ELF, BRIDGE_GUEST_ID};
use clap::Parser;
use risc0_op_steel::{
    optimism::{OpEvmEnv, BASE_SEPOLIA_CHAIN_SPEC},
    Commitment, Contract,
};
use risc0_zkvm::{default_executor, default_prover, ExecutorEnv, ProverOpts};
use tokio::task;
use tracing_subscriber::EnvFilter;
use url::Url;

sol! {
    /// MUST match `MosaicBridge.sol`'s public `deposits` getter and the guest.
    interface IMosaicBridge {
        function deposits(uint64 depositId)
            external
            view
            returns (uint32 assetId, uint256 amount, bytes32 ownerTag);
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

    /// The deposit id to prove.
    #[arg(short, long)]
    deposit_id: u64,

    /// Produce a Groth16 receipt and write the router-ready seal + journal (otherwise execute only).
    #[arg(long)]
    prove: bool,

    /// Directory for the emitted seal/journal artifacts when `--prove` is set.
    #[arg(long, default_value = "out")]
    out_dir: PathBuf,

    /// Block to read the deposit at (defaults to latest). Use the block at/after the shield tx.
    #[arg(long)]
    block: Option<u64>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();
    let args = Args::parse();

    // OP EVM environment from the RPC, optionally pinned to a block.
    let builder = OpEvmEnv::builder().rpc(args.rpc_url).chain_spec(&BASE_SEPOLIA_CHAIN_SPEC);
    let builder = match args.block {
        Some(b) => builder.block_number(b),
        None => builder,
    };
    let mut env = builder.build().await?;

    // Read the deposit record from contract state (proven against the block's state root).
    let call = IMosaicBridge::depositsCall { depositId: args.deposit_id };
    let returns = Contract::preflight(args.bridge, &mut env)
        .call_builder(&call)
        .call()
        .await?;
    log::info!(
        "Deposit {} on bridge {}: assetId={} amount={} ownerTag={}",
        args.deposit_id,
        args.bridge,
        returns.assetId,
        returns.amount,
        returns.ownerTag,
    );
    anyhow::ensure!(returns.assetId != 0, "no deposit recorded for id {}", args.deposit_id);

    let evm_input = env.into_input().await?;
    let bridge_bytes: [u8; 20] = args.bridge.into();
    let deposit_id = args.deposit_id;
    let do_prove = args.prove;

    // Execute (journal only) or prove (Groth16 receipt -> router-ready seal).
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
    // The commitment's id packs the version in the top 16 bits and the block number in the low 64.
    let commit_block = journal.commitment.id.as_limbs()[0];
    log::info!(
        "Journal: depositId={} assetId={} amount={} ownerTag={} (bridge {})",
        journal.depositId,
        journal.assetId,
        journal.amount,
        journal.ownerTag,
        journal.bridgeAddress,
    );
    log::info!(
        "ATTEST THIS BLOCK ON STELLAR -> block_number={} block_hash={}",
        commit_block,
        journal.commitment.digest,
    );

    if let Some(seal) = seal {
        fs::create_dir_all(&args.out_dir).context("failed to create out dir")?;
        fs::write(args.out_dir.join("journal.bin"), &journal_bytes)?;
        fs::write(args.out_dir.join("seal.bin"), &seal)?;
        fs::write(args.out_dir.join("journal.hex"), hex::encode(&journal_bytes))?;
        fs::write(args.out_dir.join("seal.hex"), hex::encode(&seal))?;
        log::info!(
            "Wrote {}/{{seal,journal}}.{{bin,hex}} ({} journal bytes, {} seal bytes)",
            args.out_dir.display(),
            journal_bytes.len(),
            seal.len(),
        );
    }

    Ok(())
}

#[cfg(test)]
mod fixture {
    //! Emits ground-truth values for the Stellar WS4 config: the guest image id and the Base Sepolia
    //! config digest. Run: `cargo test -p host --release -- --nocapture print_journal_fixture`
    use super::{Journal, BASE_SEPOLIA_CHAIN_SPEC};
    use alloy_primitives::{hex, Address, B256, U256};
    use alloy_sol_types::SolValue;
    use bridge_methods::BRIDGE_GUEST_ID;
    use risc0_op_steel::Commitment;
    use risc0_zkvm::sha::Digest;

    #[test]
    fn print_journal_fixture() {
        let commitment = Commitment {
            id: U256::from(0x1234u64),
            digest: B256::repeat_byte(0x11),
            configID: B256::repeat_byte(0x22),
        };
        let journal = Journal {
            commitment,
            bridgeAddress: Address::from([0xABu8; 20]),
            depositId: 7,
            assetId: 1,
            amount: U256::from(100_000_000u64),
            ownerTag: B256::repeat_byte(0x33),
        };
        let enc = journal.abi_encode();
        println!("JOURNAL_LEN={}", enc.len());
        println!("JOURNAL_HEX={}", hex::encode(&enc));
        println!("IMAGE_ID_HEX={}", hex::encode(Digest::from(BRIDGE_GUEST_ID).as_bytes()));
        println!("CONFIG_DIGEST_HEX={}", hex::encode(BASE_SEPOLIA_CHAIN_SPEC.digest()));
    }
}
