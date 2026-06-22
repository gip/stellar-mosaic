#![allow(unused_doc_comments)]
#![no_main]

//! Bridge guest: prove the Base `MosaicBridge` recorded a specific deposit, and commit the data
//! needed to mint the matching note on Stellar.
//!
//! Base is an OP-stack chain, so we prove from CONTRACT STATE via a Steel view call
//! (`eth_getProof`), not from an event/receipt (every OP block carries a type-0x7e deposit tx the
//! Ethereum receipt decoder rejects). The guest reads the OP EVM input + a bridge address + a
//! `depositId`, calls `deposits(depositId)` on that bridge, and commits an ABI-encoded `Journal`:
//! the Steel block `Commitment` (L2 block number + hash + chain-spec/config digest) plus the bridge
//! address and the note fields `(depositId, assetId, amount, ownerTag)`.
//!
//! Trust on Stellar (WS4): the RISC Zero receipt proves this journal is authentic for the pinned
//! guest image. The settlement contract then checks `commitment.configID` == the expected Base
//! Sepolia config, `bridgeAddress` == the pinned bridge, `commitment.digest` is an attested Base
//! block hash, and the `depositId` is unused — then inserts `Poseidon(assetId, amount, ownerTag)`.

use alloy_primitives::Address;
use alloy_sol_types::{sol, SolValue};
use risc0_op_steel::{
    optimism::{OpEvmInput, BASE_SEPOLIA_CHAIN_SPEC},
    Commitment, Contract,
};
use risc0_zkvm::guest::env;

risc0_zkvm::guest::entry!(main);

sol! {
    /// MUST match `MosaicBridge.sol`'s public `deposits` getter.
    interface IMosaicBridge {
        function deposits(uint64 depositId)
            external
            view
            returns (uint32 assetId, uint256 amount, bytes32 ownerTag);
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
    // Inputs: the Steel OP EVM input, then the bridge address and the target deposit id. Both are
    // committed in the journal, so the guest cannot lie about which deposit (or contract) it proved.
    let input: OpEvmInput = env::read();
    let bridge_bytes: [u8; 20] = env::read();
    let deposit_id: u64 = env::read();
    let bridge = Address::from(bridge_bytes);

    let env = input.into_env(&BASE_SEPOLIA_CHAIN_SPEC);

    // Read the deposit record from contract state (proven against the block's state root).
    let call = IMosaicBridge::depositsCall { depositId: deposit_id };
    let d = Contract::new(bridge, &env).call_builder(&call).call();
    assert!(d.assetId != 0, "no deposit recorded for this id");

    let journal = Journal {
        commitment: env.into_commitment(),
        bridgeAddress: bridge,
        depositId: deposit_id,
        assetId: d.assetId,
        amount: d.amount,
        ownerTag: d.ownerTag,
    };
    env::commit_slice(&journal.abi_encode());
}
