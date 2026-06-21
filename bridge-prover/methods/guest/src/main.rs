#![allow(unused_doc_comments)]
#![no_main]

//! Bridge guest: prove that the Base `MosaicBridge` contract emitted a specific `Shielded` event,
//! and commit the data needed to mint the matching note on Stellar.
//!
//! The guest queries the `Shielded` event of a caller-supplied bridge address, filtered to a single
//! `depositId` (an indexed topic), asserts exactly one match, and commits an ABI-encoded `Journal`:
//! the Steel block `Commitment` (block number + block hash + chain-spec/config digest) plus the
//! bridge address and the note fields `(depositId, assetId, amount, ownerTag)`.
//!
//! Trust on Stellar (WS4): the RISC Zero receipt proves this journal is authentic for the pinned
//! guest image. The settlement contract then checks `commitment.configID` == the expected Base
//! Sepolia config, `bridgeAddress` == the pinned bridge, `commitment.digest` is an attested Base
//! block hash, and the `depositId` is unused — then inserts `Poseidon(assetId, amount, ownerTag)`.

use std::sync::LazyLock;

use alloy_primitives::{Address, B256, U256};
use alloy_sol_types::{sol, SolValue};
use risc0_steel::{
    config::ChainSpec, ethereum::EthChainSpec, ethereum::EthEvmInput,
    revm::primitives::hardfork::SpecId, Commitment, Event,
};
use risc0_zkvm::guest::env;

risc0_zkvm::guest::entry!(main);

/// Base Sepolia. MUST stay identical to the host so the committed `configID` matches.
const BASE_SEPOLIA_CHAIN_ID: u64 = 84532;
static BASE_SEPOLIA_CHAIN_SPEC: LazyLock<EthChainSpec> =
    LazyLock::new(|| ChainSpec::new_single(BASE_SEPOLIA_CHAIN_ID, SpecId::PRAGUE));

sol! {
    /// MUST match `MosaicBridge.sol`'s event exactly (signature + indexed flags).
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
    /// ABI-encodable journal. MUST match the host and the Stellar parser (WS4).
    struct Journal {
        Commitment commitment;
        address bridgeAddress;
        uint64 depositId;
        uint32 assetId;
        uint256 amount;
        bytes32 ownerTag;
    }
}

fn main() {
    // Inputs: the Steel EVM input, then the bridge address and the target deposit id. The address +
    // id are committed in the journal, so the guest cannot lie about which deposit it proved.
    let input: EthEvmInput = env::read();
    let bridge_bytes: [u8; 20] = env::read();
    let deposit_id: u64 = env::read();
    let bridge = Address::from(bridge_bytes);

    let env = input.into_env(&BASE_SEPOLIA_CHAIN_SPEC);

    // Query the Shielded event for exactly this bridge + depositId (depositId is indexed -> topic1).
    let deposit_topic = B256::from(U256::from(deposit_id));
    let event = Event::new::<MosaicBridge::Shielded>(&env);
    let logs = event.address(bridge).topic1(deposit_topic).query();

    assert_eq!(logs.len(), 1, "expected exactly one Shielded event for the depositId");
    let ev = &logs[0].data;
    assert_eq!(ev.depositId, deposit_id, "decoded depositId mismatch");

    let journal = Journal {
        commitment: env.into_commitment(),
        bridgeAddress: bridge,
        depositId: ev.depositId,
        assetId: ev.assetId,
        amount: ev.amount,
        ownerTag: ev.ownerTag,
    };
    env::commit_slice(&journal.abi_encode());
}
