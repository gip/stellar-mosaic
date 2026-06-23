#![no_std]
//! Merged Desk + custody contract. Single contract owns custody, the nullifier registry, matching,
//! and settlement. See docs/architecture.md, docs/implementation.md.
//!
//! `shield`  = move a real Soroban token into custody and mint an AssetNote. Proof-free: amounts are
//!             public and the token transfer enforces the amount, so conservation needs no ZK.
//!             Emits the note fields; the off-chain tree builder ingests them and publishes the root.
//! `settle`  = ATOMIC two-sided trade in ONE tx. Verifies BOTH parties' order proofs (the lift
//!             circuit: each proves the party owns an asset note in the tree, reveals its nullifier,
//!             and commits to its order terms), checks the orders cross in plaintext from the bound
//!             public inputs, records both nullifiers, and emits proceeds. No resting on-chain order
//!             entries, no separate lift step: two crossing order proofs are matched off-chain and
//!             settled together here. Feasible because two UltraHonk verifies (~160M) fit the 400M
//!             per-tx budget (see docs/benchmarks.md).
//! `unshield`= spend an asset note with a proof and transfer the real token out, with the recipient
//!             bound into the proof so a relayer cannot redirect it.
//!
//! Order-proof public-input vector (lift circuit, 10 x 32-byte big-endian field elements):
//!   [0] domain  [1] root  [2] nullifier_in  [3] asset_in  [4] amount_in  [5] asset_out
//!   [6] min_out [7] output_owner_tag  [8] cancel_owner_tag  [9] order_leaf
//! settle uses [0..8]; cancel_owner_tag/order_leaf are unused here (no on-chain order note).

use soroban_sdk::{
    contract, contractevent, contracterror, contractimpl, contracttype, crypto::bn254::Bn254Fr,
    symbol_short, token::TokenClient, vec, xdr::ToXdr, Address, Bytes, BytesN, Env, IntoVal, Vec,
    U256,
};
use soroban_poseidon::{Field, Poseidon2Config, Poseidon2Sponge};
use ultrahonk_soroban_verifier::{UltraHonkVerifier, PROOF_BYTES};

// --- Events ---------------------------------------------------------------------------------------
// These are the cross-chain/indexer WIRE CONTRACT (the indexer and backend reconstruct the note tree
// by parsing them positionally: one Symbol topic + a data Vec). They replace the deprecated
// `env.events().publish((symbol_short!(name),), (..tuple..))` form.
//
// `data_format = "vec"` is REQUIRED (the macro default is `"map"`): it makes the emitted data an
// `ScVal::Vec` of the fields in declaration order — byte-identical to the old tuple encoding the
// indexer reads. The explicit `topics = [name]` reproduces the single short-Symbol topic. Do not add
// `#[topic]` fields, reorder fields, or change `data_format` without updating every event consumer
// (tools/indexer, backend/src/indexer.rs) and the wire-format test in tests/events.rs.

/// One AssetNote shielded into the tree (native `shield` and `shield_from_base`).
#[contractevent(topics = ["shielded"], data_format = "vec")]
pub struct Shielded {
    pub asset_id: u32,
    pub amount: i128,
    pub owner_tag: BytesN<32>,
}

/// One AssetNote minted by an internal path (e.g. `join` outputs). Same shape as `Shielded`, distinct
/// topic so consumers can tell a mint from a user shield.
#[contractevent(topics = ["noteins"], data_format = "vec")]
pub struct NoteInserted {
    pub asset: u32,
    pub amount: i128,
    pub owner_tag: BytesN<32>,
}

/// One leaf appended to the ORDER-commitment tree (a placement or a re-rested match remainder), in
/// tree-insert order. Lets the indexer rebuild order-tree membership paths.
#[contractevent(topics = ["orderins"], data_format = "vec")]
pub struct OrderInserted {
    pub order_leaf: BytesN<32>,
}

/// One nullifier consumed into the indexed-merkle-tree accumulator, in insert order. Covers both the
/// secret-derived note-spend nullifiers and the public order-consumption nullifiers; the indexer
/// replays these to maintain the IMT and produce low-leaf witnesses for the next spender.
#[contractevent(topics = ["nfspent"], data_format = "vec")]
pub struct NullifierSpent {
    pub nullifier: BytesN<32>,
}

/// An asset note spent out of custody to a real recipient.
#[contractevent(topics = ["unshield"], data_format = "vec")]
pub struct Unshielded {
    pub asset: u32,
    pub amount: i128,
    pub nullifier: BytesN<32>,
}

/// A join: two consumed notes' nullifiers (the two minted outputs are separate `noteins`).
#[contractevent(topics = ["joined"], data_format = "vec")]
pub struct Joined {
    pub asset: u32,
    pub nf1: BytesN<32>,
    pub nf2: BytesN<32>,
}

/// Informational summary of a `settle_match`: the resulting nullifier accumulator root (clients can
/// confirm their order was consumed by scanning the `nfspent`/`noteins`/`orderins` events of the tx).
#[contractevent(topics = ["matched"], data_format = "vec")]
pub struct Matched {
    pub nullifier_root_out: BytesN<32>,
}

/// Poseidon2 S-box degree (BN254). The crate's SBOX_D is pub(crate); the value is fixed at 5.
const SBOX_D: u32 = 5;
/// Poseidon2 state width used by the circuits (t = 4, rate 3).
const POSEIDON_T: u32 = 4;

/// Operation ids: also index the per-operation verification keys (`DataKey::Vk(op)`) and match the
/// circuit domain separators (lift/order circuit domain = 1, unshield circuit domain = 2).
const LIFT_OP: u32 = 1;
const UNSHIELD_OP: u32 = 2;
const CANCEL_OP: u32 = 3;
const JOIN_OP: u32 = 4;
const MATCH_OP: u32 = 5;

/// WS4 public-input lengths (positional, 32-byte big-endian field words). Every spend now also binds
/// the nullifier-IMT transition (`nullifier_root_in`/`out`); see docs/noir-matching.md and circuits/.
//   lift/place_order: [0]domain [1]note_root [2]nf_root_in [3]nf_root_out [4]nullifier_in
//                     [5]asset_in [6]amount_in [7]asset_out [8]min_out [9]output_owner_tag
//                     [10]cancel_owner_tag [11]expiry [12]partial_allowed [13]order_leaf
const LIFT_PUBLIC_INPUTS_BYTES: u32 = 14 * 32;
//   unshield: [0]domain [1]note_root [2]nf_root_in [3]nf_root_out [4]nullifier [5]asset [6]amount
//             [7]recipient
const UNSHIELD_PUBLIC_INPUTS_BYTES: u32 = 8 * 32;
//   cancel: [0]domain [1]order_root [2]nf_root_in [3]nf_root_out [4]order_nullifier [5]asset_in
//           [6]amount_in [7]return_owner_tag
const CANCEL_PUBLIC_INPUTS_BYTES: u32 = 8 * 32;
//   join: [0]domain [1]note_root [2]nf_root_in [3]nf_root_out [4]nullifier_1 [5]nullifier_2
//         [6]asset [7]out_tag_1 [8]out_amount_1 [9]out_tag_2 [10]out_amount_2
const JOIN_PUBLIC_INPUTS_BYTES: u32 = 11 * 32;
//   match (settle_match): [0]domain [1]order_root [2]nf_root_in [3]nf_root_out [4]now
//         [5..9] four consumed order nullifiers (taker + up to 3 makers; 0 = unused)
//         [9..25] four proceeds slots {live, asset, amount, note_owner_tag}
//         [25]remainder_live [26]remainder_order_leaf
const MATCH_PUBLIC_INPUTS_BYTES: u32 = 27 * 32;
/// Domain separators as 32-byte big-endian field words.
const LIFT_DOMAIN: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
];
const UNSHIELD_DOMAIN: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
];
const CANCEL_DOMAIN: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
];
const JOIN_DOMAIN: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4,
];
const MATCH_DOMAIN: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5,
];

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    // 1 and 2 are reserved (formerly EntryNotFound / AlreadyConsumed from the two-phase
    // lift+settle design, removed in the atomic-settle refactor). Kept to preserve discriminants.
    Reserved1 = 1,
    Reserved2 = 2,
    NullifierUsed = 3,
    NotCompatible = 4,
    VkNotSet = 5,
    VkInvalid = 6,
    ProofParseError = 7,
    VerificationFailed = 8,
    BadPublicInputs = 9, // wrong public-input length or wrong domain separator
    UnknownRoot = 10,    // root not in the published root history
    FieldOverflow = 11,  // a field element did not fit the expected u32/i128 range
    AssetNotRegistered = 12, // no token contract mapped to this asset id
    InvalidAmount = 13,      // shield/unshield amount must be positive
    AssetAlreadyRegistered = 14, // asset id already mapped (admin must not silently rebind)
    RecipientMismatch = 15,  // unshield payout address does not match the proof-bound recipient
    PairNotRegistered = 16,  // (asset_in, asset_out) is not a registered canonical pair
    OrderExpired = 17,       // order's validity time has passed (Phase 2)
    BookFull = 18,           // no free slot on the order's side of the book (Phase 2)
    OrderNotFound = 19,      // cancel/match referenced an order not present in the book (Phase 2)
    NotPartialAllowed = 20,  // order forbids partial execution but could not fully fill (Phase 2)
    PairAlreadyRegistered = 21, // canonical pair already defined (admin must not redefine)
    BaseBridgeNotConfigured = 22, // shield_from_base called before the Base bridge config was set
    BadJournal = 23,            // RISC Zero journal has the wrong length / non-Block commitment
    ConfigMismatch = 24,        // journal configID != the configured Base Sepolia chain-spec digest
    BridgeMismatch = 25,        // journal bridgeAddress != the configured Base bridge address
    BaseBlockNotAttested = 26,  // journal block hash is not in the relayer-attested block registry
    DepositAlreadyProcessed = 27, // this Base depositId has already minted a note (replay)
}

/// Depth of the on-chain append-only Merkle note tree (matches the circuits' TREE_DEPTH).
const TREE_DEPTH: u32 = 32;

/// Precomputed zero-subtree hashes (zeros[i]); zeros[0]=0, zeros[i]=compress(zeros[i-1],zeros[i-1]).
/// Hardcoded so inserts don't pay a storage read every call; verified against the circuit in tests.
const TREE_ZEROS: [[u8; 32]; 32] = [
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    [0x18, 0xdf, 0xb8, 0xdc, 0x9b, 0x82, 0x22, 0x9c, 0xff, 0x97, 0x4e, 0xfe, 0xfc, 0x8d, 0xf7, 0x8b, 0x1c, 0xe9, 0x6d, 0x9d, 0x84, 0x42, 0x36, 0xb4, 0x96, 0x78, 0x5c, 0x69, 0x8b, 0xc6, 0x73, 0x2e],
    [0x2c, 0x0d, 0x18, 0x4f, 0xc7, 0xa2, 0x5c, 0x12, 0x4a, 0x27, 0xa6, 0x7b, 0x2c, 0x46, 0x22, 0x0b, 0x03, 0x9b, 0x1a, 0x50, 0x72, 0xc3, 0xb6, 0x93, 0xa1, 0x8f, 0xfe, 0xe4, 0x58, 0xf6, 0x42, 0x5d],
    [0x26, 0x8b, 0x2b, 0x93, 0xac, 0x5f, 0xe5, 0x40, 0xe6, 0x18, 0xa3, 0x78, 0xb8, 0xa7, 0x1b, 0x8f, 0x24, 0x07, 0x23, 0x27, 0x44, 0xd7, 0x1e, 0x50, 0x1c, 0xe8, 0x69, 0x99, 0x80, 0xb3, 0x06, 0xe5],
    [0x2d, 0x43, 0x6f, 0x65, 0x4e, 0x14, 0xcc, 0x4f, 0xeb, 0xca, 0xfd, 0xf4, 0xa7, 0x53, 0xb1, 0x49, 0xdd, 0x8c, 0x88, 0xa7, 0x5d, 0xf9, 0xe5, 0xd6, 0x70, 0x7e, 0x83, 0xa8, 0x53, 0xb5, 0xf7, 0x91],
    [0x0b, 0x66, 0xfd, 0xef, 0x5a, 0x7f, 0x00, 0xf6, 0xfb, 0x45, 0xd1, 0x49, 0x8b, 0x4d, 0x71, 0x31, 0x21, 0x8e, 0x69, 0xcc, 0xf0, 0xa2, 0x75, 0x1b, 0x6a, 0x1f, 0xb1, 0xbc, 0xd9, 0x82, 0x86, 0x7d],
    [0x1d, 0x54, 0x2b, 0x47, 0x6c, 0x67, 0x1b, 0xb6, 0xf0, 0xd2, 0xab, 0x29, 0x39, 0x33, 0x5d, 0x7c, 0xba, 0xd0, 0x34, 0x76, 0xf1, 0xe3, 0xbc, 0xba, 0x70, 0x97, 0x3b, 0x1a, 0xdf, 0xe8, 0x8b, 0x91],
    [0x06, 0x80, 0xc6, 0x38, 0x8c, 0x57, 0x98, 0xca, 0xf8, 0x06, 0x42, 0xa1, 0xe8, 0x43, 0x16, 0xb8, 0xb2, 0xf7, 0xca, 0xa9, 0x9d, 0xa0, 0x76, 0xf3, 0x05, 0x7d, 0x29, 0x62, 0xa4, 0x6c, 0x53, 0x58],
    [0x03, 0xc5, 0x3c, 0xe5, 0x29, 0x6e, 0x3e, 0x89, 0x51, 0x71, 0xf8, 0x9a, 0xa0, 0x9f, 0x84, 0x21, 0x4e, 0x3f, 0xb0, 0x75, 0x5f, 0xe7, 0xa4, 0x23, 0xb8, 0x78, 0x88, 0xe4, 0xb3, 0xd7, 0x31, 0xb8],
    [0x2d, 0xd4, 0xe2, 0x51, 0x0b, 0x33, 0x27, 0x53, 0x59, 0xbb, 0xa6, 0xed, 0xf7, 0x2e, 0x6b, 0xda, 0xca, 0xd2, 0x59, 0x95, 0x0b, 0x02, 0x4b, 0x2c, 0xc1, 0x9d, 0x63, 0xc3, 0xa5, 0xb7, 0x61, 0xdf],
    [0x11, 0xcb, 0x22, 0x1f, 0x69, 0xd9, 0x54, 0xd5, 0x21, 0xfb, 0x53, 0x93, 0x76, 0x7e, 0x77, 0xfe, 0x4d, 0x14, 0x13, 0x37, 0x57, 0xa7, 0x06, 0xb3, 0x18, 0xe6, 0x2f, 0xa9, 0x84, 0xf9, 0x81, 0x57],
    [0x03, 0x9d, 0x78, 0xba, 0xc8, 0xf8, 0x90, 0x78, 0x8e, 0xef, 0xe3, 0x9a, 0xf1, 0x5e, 0xee, 0x58, 0x25, 0x05, 0x66, 0x48, 0xf9, 0x92, 0x10, 0x05, 0x4f, 0xd0, 0x3c, 0x25, 0x21, 0x3f, 0x4d, 0xe7],
    [0x0c, 0x55, 0xb8, 0x28, 0xa8, 0x30, 0x62, 0xa7, 0x7d, 0x2b, 0x3e, 0x0a, 0x66, 0xbb, 0xb5, 0x0c, 0xb6, 0x04, 0x09, 0x90, 0xd9, 0xf3, 0x68, 0xda, 0x8b, 0x24, 0xc0, 0xe8, 0x2b, 0x69, 0x23, 0x49],
    [0x24, 0xc8, 0x66, 0xac, 0x88, 0x71, 0x58, 0x51, 0x26, 0x8d, 0x80, 0x84, 0x87, 0xe2, 0x0e, 0x69, 0x86, 0x08, 0x4f, 0xc2, 0x22, 0xd7, 0x18, 0x8e, 0x2a, 0x8e, 0x0f, 0x5b, 0x9f, 0x84, 0x57, 0xef],
    [0x0f, 0x6a, 0x94, 0xe4, 0x37, 0xb9, 0xdf, 0xb3, 0x5c, 0xde, 0xdf, 0x41, 0xe2, 0xe1, 0x54, 0xc3, 0xae, 0x44, 0x9b, 0x7c, 0x04, 0xc1, 0x3a, 0xdd, 0x09, 0x96, 0xa7, 0xb5, 0x3c, 0xde, 0x54, 0x00],
    [0x22, 0xaf, 0xe7, 0x69, 0x6b, 0x87, 0xcb, 0x78, 0x27, 0x42, 0xe2, 0xd3, 0xec, 0xb0, 0xf7, 0x49, 0xa9, 0xbe, 0xef, 0xbb, 0xb2, 0x15, 0x9d, 0x17, 0x8b, 0x09, 0x00, 0x0e, 0x55, 0xb2, 0x2c, 0xab],
    [0x12, 0x1b, 0x01, 0x16, 0x4d, 0x32, 0xe9, 0xab, 0x84, 0x1b, 0xa8, 0xf5, 0x60, 0x2b, 0x0e, 0xc5, 0x8b, 0x57, 0x6e, 0x62, 0x55, 0x2c, 0x96, 0x91, 0x1d, 0x4d, 0x98, 0x8d, 0x49, 0x46, 0x8c, 0xdd],
    [0x05, 0xf3, 0x81, 0x07, 0x07, 0xb1, 0x33, 0x6c, 0x95, 0x3b, 0x7d, 0xb1, 0x91, 0x21, 0x5d, 0xab, 0x2b, 0x57, 0x72, 0xf9, 0x30, 0x25, 0xaa, 0x34, 0x5b, 0x95, 0x4b, 0x43, 0x13, 0x5b, 0x62, 0x7b],
    [0x28, 0x75, 0x15, 0xb2, 0xd5, 0x97, 0x5c, 0x74, 0xe3, 0xfd, 0x85, 0xa2, 0x0d, 0x68, 0x61, 0x1a, 0x46, 0x3f, 0xfe, 0x60, 0x5a, 0x1c, 0x54, 0xd8, 0x14, 0x0a, 0xb1, 0x6d, 0x1b, 0x77, 0xf5, 0x7b],
    [0x27, 0x6f, 0xf1, 0x3f, 0xde, 0x3a, 0xfa, 0x1a, 0xdb, 0x26, 0x14, 0x9d, 0xdc, 0x3a, 0xa6, 0x72, 0x40, 0xd6, 0x03, 0xb6, 0xa9, 0x1d, 0xa5, 0xe4, 0x94, 0xc8, 0xe5, 0x87, 0x06, 0x38, 0x1a, 0x38],
    [0x30, 0x39, 0xbc, 0xb2, 0x0f, 0x03, 0xfd, 0x9c, 0x86, 0x50, 0x13, 0x8e, 0xf2, 0xcf, 0xe6, 0x43, 0xed, 0xee, 0xd1, 0x52, 0xf9, 0xc2, 0x09, 0x99, 0xf4, 0x3a, 0xee, 0xd5, 0x4d, 0x79, 0xe3, 0x87],
    [0x08, 0x7e, 0x5a, 0xf4, 0x39, 0x45, 0x0e, 0xf0, 0x9c, 0xe6, 0xf1, 0x2a, 0x47, 0x57, 0x19, 0x71, 0xd8, 0x33, 0x09, 0xbb, 0x6f, 0xd1, 0xe2, 0x80, 0xc2, 0x9b, 0xaf, 0x69, 0x25, 0x7f, 0x8a, 0x4f],
    [0x18, 0x21, 0x49, 0x5b, 0x19, 0x19, 0xfa, 0x54, 0x39, 0xae, 0x4a, 0x31, 0x4f, 0xf9, 0x88, 0x43, 0x06, 0x73, 0x81, 0xa3, 0xc0, 0x15, 0xf7, 0x44, 0x59, 0x2b, 0xfd, 0x64, 0x10, 0x1d, 0xef, 0x1d],
    [0x25, 0x78, 0x9f, 0x32, 0xf9, 0x58, 0x56, 0x83, 0x64, 0xc8, 0x13, 0x97, 0x71, 0xd7, 0x86, 0x4d, 0x93, 0xf9, 0x7e, 0xfb, 0x5b, 0xbb, 0x87, 0xcc, 0xe1, 0x95, 0x9e, 0x7e, 0x74, 0x43, 0xac, 0x80],
    [0x25, 0xad, 0x08, 0x50, 0x41, 0x15, 0x51, 0x11, 0x5f, 0xd6, 0x97, 0xc4, 0xd9, 0x16, 0x68, 0xf9, 0x2d, 0xde, 0x52, 0x42, 0x1b, 0xe5, 0x96, 0x50, 0x35, 0x7c, 0xd5, 0x03, 0x63, 0x88, 0x05, 0x43],
    [0x10, 0xb6, 0x04, 0xf3, 0x5a, 0x90, 0x24, 0x19, 0xa0, 0xfd, 0xcf, 0x8e, 0xe5, 0x71, 0x23, 0xe9, 0x2f, 0x0d, 0x65, 0x0a, 0xb0, 0x09, 0xb5, 0x10, 0x59, 0x16, 0xca, 0xc7, 0x81, 0x3c, 0x91, 0x37],
    [0x1b, 0xb0, 0x7b, 0x96, 0xcd, 0xdd, 0xee, 0x48, 0x6a, 0xfb, 0x20, 0xc7, 0x8a, 0x3b, 0x82, 0x20, 0x8c, 0xb8, 0x0d, 0x2c, 0x55, 0xe5, 0x96, 0x89, 0x6f, 0xa1, 0x87, 0x91, 0x64, 0xa7, 0x51, 0xdb],
    [0x04, 0xab, 0x93, 0xe9, 0xc4, 0x94, 0xb6, 0x71, 0x62, 0x06, 0x3e, 0x77, 0x96, 0x0c, 0xd3, 0x6f, 0x4e, 0x3e, 0x5c, 0xde, 0xe5, 0x38, 0x8a, 0x60, 0x3d, 0xc5, 0x5a, 0x03, 0x87, 0x5c, 0x72, 0xbb],
    [0x0f, 0x9e, 0x7f, 0x4a, 0xd9, 0x48, 0xe7, 0xe4, 0x87, 0x83, 0x1c, 0x37, 0xfe, 0xf6, 0xe0, 0x32, 0xd6, 0x6a, 0xb2, 0xcd, 0x3d, 0x74, 0x2d, 0x02, 0x42, 0x74, 0x61, 0x2a, 0x86, 0xcc, 0x55, 0xed],
    [0x2f, 0x1c, 0x69, 0x20, 0x64, 0x4c, 0xd6, 0x74, 0x37, 0x6a, 0x6d, 0x3b, 0xa4, 0xfd, 0x3c, 0xbe, 0x3a, 0x57, 0x16, 0x85, 0xaf, 0x0d, 0x9a, 0xb2, 0x8e, 0x14, 0x61, 0xe4, 0xc1, 0xd6, 0xfc, 0x0a],
    [0x0d, 0xe2, 0xcd, 0x9d, 0xff, 0xe1, 0xe7, 0x10, 0x64, 0x7f, 0xdc, 0x17, 0x98, 0x84, 0xbd, 0x03, 0x67, 0x27, 0x66, 0x12, 0xef, 0x83, 0xd2, 0xae, 0xea, 0x0f, 0x7d, 0x8a, 0xec, 0xb9, 0xc3, 0xd7],
    [0x00, 0x77, 0xed, 0x17, 0xda, 0xd4, 0xb5, 0x61, 0xa9, 0xb4, 0xa2, 0x1c, 0xf5, 0x87, 0x20, 0xef, 0x0c, 0x05, 0x76, 0x99, 0xfe, 0xc7, 0x2b, 0x92, 0xf2, 0xca, 0x26, 0xfd, 0xf6, 0xb4, 0x8a, 0x83],
];

#[contracttype]
pub enum DataKey {
    Vk(u32), // verification key per operation (LIFT_OP / UNSHIELD_OP / ... / MATCH_OP)
    Admin,
    Root(BytesN<32>), // set membership: this NOTE-tree root was produced on-chain (accepted)
    Asset(u32), // asset id -> token contract Address
    // --- Note-commitment tree (asset notes) ---
    TreeFilled, // Vec<U256> of length TREE_DEPTH: rightmost filled node per level
    TreeNext,   // u32: number of leaves inserted so far
    TreeRoot,   // U256: current note-tree root
    // --- Order-commitment tree (resting orders) ---
    OrderTreeFilled,
    OrderTreeNext,
    OrderTreeRoot,
    OrderRoot(BytesN<32>), // set membership: this ORDER-tree root was produced on-chain (accepted)
    // --- Nullifier accumulator (indexed merkle tree) ---
    // Only the CURRENT root is valid: every spend proves its non-membership+insert in-circuit and
    // the contract CAS-advances this single root (no on-chain Poseidon, no per-nullifier rent).
    NullifierRoot, // U256
    Pair(u32),  // pair id -> PairDef { base_asset, quote_asset } (canonical orientation)
    PairCount,  // u32: number of registered pairs (pair ids are 0..PairCount)
    // --- Base-shield bridge (one-way deposit from Base; see docs/base-bridge.md) ---
    BaseRouter,         // Address: deployed RISC Zero verifier router (cross-called to verify)
    BaseImageId,        // BytesN<32>: pinned guest image id (bridge-prover BRIDGE_GUEST_ID)
    BaseConfigId,       // BytesN<32>: expected Steel configID (Base Sepolia chain-spec digest)
    BaseBridgeAddr,     // BytesN<20>: expected Base MosaicBridge address bound in the journal
    BaseBlock(u64),     // block number -> attested Base block hash (relayer-attested registry)
    BaseDeposit(u64),   // Base depositId -> true (single-use; prevents double-mint)
}

/// A canonical trading pair. Orders are always specified base/quote in this orientation
/// (e.g. XLM/USDC, never USDC/XLM); the reverse orientation is rejected at registration and
/// when deriving an order's pair. SELL = give base / want quote; BUY = give quote / want base.
#[contracttype]
#[derive(Clone)]
pub struct PairDef {
    pub base_asset: u32,
    pub quote_asset: u32,
}

/// Which side of the book an order sits on, derived from (asset_in, asset_out) vs the pair's
/// canonical (base, quote). SELL gives base for quote; BUY gives quote for base.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Side {
    Buy,
    Sell,
}

/// One verified side of a trade, derived entirely from a verified order proof's public inputs.
// The book fields ([8..12]) are read by the Phase 2 order-book entrypoints, added next.
#[allow(dead_code)]
struct Order {
    nullifier: BytesN<32>,
    asset_in: u32,
    amount_in: i128,
    asset_out: u32,
    min_out: i128,
    output_owner_tag: BytesN<32>,
    // Order-book fields (lift public inputs [8..12]). `settle`/`settle_exact` ignore these; the book
    // (`submit_order`/`cancel_order`) trusts them because the proof bound them into `order_leaf`.
    cancel_owner_tag: BytesN<32>,
    expiry: u64,
    partial_allowed: bool,
    order_leaf: BytesN<32>,
}

#[contract]
pub struct Settlement;

#[contractimpl]
impl Settlement {
    /// Store the order (lift) UltraHonk verification key (validated by parsing) and the admin. The
    /// unshield VK is registered separately via `set_vk(UNSHIELD_OP, ..)` (a different circuit).
    pub fn __constructor(env: Env, vk_bytes: Bytes, admin: Address) -> Result<(), Error> {
        let _ = UltraHonkVerifier::new(&env, &vk_bytes).map_err(|_| Error::VkInvalid)?;
        env.storage().persistent().set(&DataKey::Vk(LIFT_OP), &vk_bytes);
        env.storage().instance().set(&DataKey::Admin, &admin);
        let h = Hasher::new(&env);
        tree_init(&env, &h, TreeId::Note);
        tree_init(&env, &h, TreeId::Order);
        // Nullifier accumulator starts at the empty-IMT genesis root (single {0,0,0} leaf).
        let nf_genesis = imt_genesis_root(&env, &h);
        env.storage().persistent().set(&DataKey::NullifierRoot, &nf_genesis);
        bump(&env, &DataKey::Vk(LIFT_OP));
        bump_core(&env); // instance + tree singletons to max from the start
        Ok(())
    }

    /// Register the verification key for an operation (e.g. UNSHIELD_OP). Admin-gated and validated
    /// by parsing. Each operation is a distinct circuit, so it needs its own VK.
    pub fn set_vk(env: Env, op: u32, vk_bytes: Bytes) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let _ = UltraHonkVerifier::new(&env, &vk_bytes).map_err(|_| Error::VkInvalid)?;
        env.storage().persistent().set(&DataKey::Vk(op), &vk_bytes);
        bump(&env, &DataKey::Vk(op));
        Ok(())
    }

    /// Current note-commitment tree root (the latest; any past root stays accepted too).
    pub fn root(env: Env) -> BytesN<32> {
        let r: U256 = env
            .storage()
            .persistent()
            .get(&DataKey::TreeRoot)
            .expect("tree initialized at construction");
        u256_to_bytesn(&env, &r)
    }

    /// Current order-commitment tree root (the latest; any past root stays accepted too).
    pub fn order_root(env: Env) -> BytesN<32> {
        let r: U256 = env
            .storage()
            .persistent()
            .get(&DataKey::OrderTreeRoot)
            .expect("order tree initialized at construction");
        u256_to_bytesn(&env, &r)
    }

    /// Current nullifier accumulator (IMT) root. Only this exact root is valid as a spend's
    /// `nullifier_root_in`; each spend CAS-advances it.
    pub fn nullifier_root(env: Env) -> BytesN<32> {
        u256_to_bytesn(&env, &nullifier_root(&env))
    }

    /// Map a supported asset id to its real Soroban token contract. Admin-gated; assets are not
    /// silently rebindable (rebinding a live asset id would orphan custodied balances).
    pub fn register_asset(env: Env, asset_id: u32, token: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        if env.storage().persistent().has(&DataKey::Asset(asset_id)) {
            return Err(Error::AssetAlreadyRegistered);
        }
        env.storage().persistent().set(&DataKey::Asset(asset_id), &token);
        bump(&env, &DataKey::Asset(asset_id));
        Ok(())
    }

    /// Register a canonical trading pair `base/quote` (e.g. XLM/USDC). Admin-gated. Both assets must
    /// already be registered. The canonical orientation is fixed here: an order is matched against
    /// this pair only when its assets are `{base, quote}`; the orientation itself is derived from the
    /// pair definition, never from the order, so XLM/USDC and USDC/XLM are the same market. Returns
    /// the assigned pair id. Pairs are not redefinable (would orphan resting orders).
    pub fn register_pair(env: Env, base_asset: u32, quote_asset: u32) -> Result<u32, Error> {
        Self::require_admin(&env)?;
        if base_asset == quote_asset {
            return Err(Error::PairNotRegistered);
        }
        if !env.storage().persistent().has(&DataKey::Asset(base_asset))
            || !env.storage().persistent().has(&DataKey::Asset(quote_asset))
        {
            return Err(Error::AssetNotRegistered);
        }
        // Reject a duplicate in either orientation: the pair is canonical, so {a,b} == {b,a}.
        let count: u32 = env.storage().persistent().get(&DataKey::PairCount).unwrap_or(0);
        let mut i = 0u32;
        while i < count {
            let p: PairDef = env.storage().persistent().get(&DataKey::Pair(i)).unwrap();
            if (p.base_asset == base_asset && p.quote_asset == quote_asset)
                || (p.base_asset == quote_asset && p.quote_asset == base_asset)
            {
                return Err(Error::PairAlreadyRegistered);
            }
            i += 1;
        }
        let pair_id = count;
        env.storage().persistent().set(
            &DataKey::Pair(pair_id),
            &PairDef { base_asset, quote_asset },
        );
        env.storage().persistent().set(&DataKey::PairCount, &(count + 1));
        bump(&env, &DataKey::Pair(pair_id));
        bump(&env, &DataKey::PairCount);
        Ok(pair_id)
    }

    /// Shield: move `amount` of a registered asset into custody and mint an AssetNote
    /// `{ asset_id, amount, owner_tag }`. Proof-free: the token transfer enforces the amount and
    /// amounts are public, so value conservation needs no ZK. The minted note's leaf
    /// `Poseidon(asset_id, amount, owner_tag)` is rebuilt off-chain from the emitted event; the
    /// contract does not pay on-chain Poseidon. `owner_tag` is the caller's opaque one-time address;
    /// choosing it wrongly only forfeits the caller's own ability to spend the note later.
    pub fn shield(
        env: Env,
        from: Address,
        asset_id: u32,
        amount: i128,
        owner_tag: BytesN<32>,
    ) -> Result<(), Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let token: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Asset(asset_id))
            .ok_or(Error::AssetNotRegistered)?;

        // Pull the real tokens into custody. `from` authorized above; the token contract enforces
        // the balance, so custody can never exceed what was actually shielded.
        TokenClient::new(&env, &token).transfer(&from, &env.current_contract_address(), &amount);

        // Mint the AssetNote into the on-chain tree (leaf = Poseidon(asset, amount, owner_tag)),
        // which advances and accepts the new root. The event lets the off-chain client rebuild
        // membership paths (the tree stores only filled subtrees, not all leaves).
        let h = Hasher::new(&env);
        let leaf = asset_note_leaf(&env, &h, asset_id, amount, &owner_tag);
        tree_insert(&env, &h, TreeId::Note, &leaf);
        Shielded { asset_id, amount, owner_tag }.publish(&env);
        bump_core(&env);
        Ok(())
    }

    /// Configure the Base-shield bridge (admin). `router` is the deployed RISC Zero verifier router
    /// this contract cross-calls; `image_id` is the pinned bridge guest image id; `config_id` is the
    /// expected Steel `configID` (Base Sepolia chain-spec digest); `bridge` is the Base MosaicBridge
    /// address the journal must carry. Re-settable so the guest/bridge can be rotated.
    pub fn configure_base_bridge(
        env: Env,
        router: Address,
        image_id: BytesN<32>,
        config_id: BytesN<32>,
        bridge: BytesN<20>,
    ) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().persistent().set(&DataKey::BaseRouter, &router);
        env.storage().persistent().set(&DataKey::BaseImageId, &image_id);
        env.storage().persistent().set(&DataKey::BaseConfigId, &config_id);
        env.storage().persistent().set(&DataKey::BaseBridgeAddr, &bridge);
        bump(&env, &DataKey::BaseRouter);
        bump(&env, &DataKey::BaseImageId);
        bump(&env, &DataKey::BaseConfigId);
        bump(&env, &DataKey::BaseBridgeAddr);
        Ok(())
    }

    /// Attest a finalized Base block hash (admin/relayer). This is the bridge's trust anchor: a Steel
    /// proof shows an event is in block `block_hash`, but only this registry asserts that hash is
    /// canonical Base. `shield_from_base` checks the journal's block hash against this map.
    pub fn attest_base_block(env: Env, block_number: u64, block_hash: BytesN<32>) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let key = DataKey::BaseBlock(block_number);
        env.storage().persistent().set(&key, &block_hash);
        bump(&env, &key);
        Ok(())
    }

    /// Shield from Base: mint an AssetNote from a proven Base deposit (one-way peg). `journal` is the
    /// ABI-encoded RISC Zero journal the bridge guest committed; `seal` is its Groth16 receipt. The
    /// contract verifies the receipt via the configured router (binding the pinned image id), then
    /// checks the journal's chain config, bridge address, and attested block hash, guards the
    /// depositId against replay, and inserts `Poseidon(asset_id, amount, owner_tag)` into the same
    /// on-chain tree as a native `shield` — emitting an identical `shielded` event so the off-chain
    /// indexer is unchanged. No Stellar token custody moves (the real USDC is locked on Base).
    pub fn shield_from_base(env: Env, seal: Bytes, journal: Bytes) -> Result<(), Error> {
        let router: Address = env
            .storage()
            .persistent()
            .get(&DataKey::BaseRouter)
            .ok_or(Error::BaseBridgeNotConfigured)?;
        let image_id: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::BaseImageId)
            .ok_or(Error::BaseBridgeNotConfigured)?;
        let expected_config: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::BaseConfigId)
            .ok_or(Error::BaseBridgeNotConfigured)?;
        let expected_bridge: BytesN<20> = env
            .storage()
            .persistent()
            .get(&DataKey::BaseBridgeAddr)
            .ok_or(Error::BaseBridgeNotConfigured)?;

        // The journal is a fixed 8-word ABI tuple (see bridge-prover/README.md). Reject any other
        // length before hashing so a malformed input cannot be passed to the verifier.
        if journal.len() != 256 {
            return Err(Error::BadJournal);
        }

        // Verify the RISC Zero receipt through the router: it reconstructs the claim from `image_id`
        // + sha256(journal) and checks the seal. Cross-call (SDK-version agnostic); traps on an
        // invalid proof, so reaching the next line means the journal is authentic for our guest.
        let journal_digest: BytesN<32> = env.crypto().sha256(&journal).into();
        env.invoke_contract::<()>(
            &router,
            &symbol_short!("verify"),
            vec![
                &env,
                seal.into_val(&env),
                image_id.into_val(&env),
                journal_digest.into_val(&env),
            ],
        );

        // Parse the journal: [0] commitment.id  [1] blockHash  [2] configID  [3] bridgeAddress
        //                     [4] depositId     [5] assetId    [6] amount    [7] ownerTag
        // word_to_u64 on the id requires the top 24 bytes to be zero, which also enforces the Block
        // commitment version (0) and a 64-bit block number.
        let block_number = word_to_u64(&read_word(&journal, 0))?;
        let block_hash = BytesN::from_array(&env, &read_word(&journal, 32));
        let config_id = BytesN::from_array(&env, &read_word(&journal, 64));
        let bridge_word = read_word(&journal, 96);
        let deposit_id = word_to_u64(&read_word(&journal, 128))?;
        let asset_id = word_to_u32(&read_word(&journal, 160))?;
        let amount = word_to_i128(&read_word(&journal, 192))?;
        let owner_tag: BytesN<32> = BytesN::from_array(&env, &read_word(&journal, 224));

        // Chain config must be the expected Base Sepolia chain spec.
        if config_id != expected_config {
            return Err(Error::ConfigMismatch);
        }
        // bridgeAddress is an EVM address ABI-encoded as a 32-byte word: 12 zero bytes then 20 addr
        // bytes. Bind it to the configured bridge so a same-signature event from another contract is
        // rejected.
        let mut addr20 = [0u8; 20];
        for i in 0..12 {
            if bridge_word[i] != 0 {
                return Err(Error::BridgeMismatch);
            }
        }
        addr20.copy_from_slice(&bridge_word[12..32]);
        if BytesN::from_array(&env, &addr20) != expected_bridge {
            return Err(Error::BridgeMismatch);
        }
        // The proven block hash must be one the relayer attested as canonical Base.
        let attested: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::BaseBlock(block_number))
            .ok_or(Error::BaseBlockNotAttested)?;
        if attested != block_hash {
            return Err(Error::BaseBlockNotAttested);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        // The note's asset must be a known protocol asset (so it is spendable/tradeable like a native
        // shield). Custody equivalence (Base-USDC == Stellar-USDC) is the documented one-way peg.
        if !env.storage().persistent().has(&DataKey::Asset(asset_id)) {
            return Err(Error::AssetNotRegistered);
        }
        // Single-use: one mint per Base depositId.
        let dk = DataKey::BaseDeposit(deposit_id);
        if env.storage().persistent().has(&dk) {
            return Err(Error::DepositAlreadyProcessed);
        }
        env.storage().persistent().set(&dk, &true);
        bump(&env, &dk);

        // Mint the AssetNote into the on-chain tree, byte-identical to a native shield's leaf.
        let h = Hasher::new(&env);
        let leaf = asset_note_leaf(&env, &h, asset_id, amount, &owner_tag);
        tree_insert(&env, &h, TreeId::Note, &leaf);
        Shielded { asset_id, amount, owner_tag }.publish(&env);
        bump_core(&env);
        Ok(())
    }

    /// Place an order into the off-chain-matched book. Verifies the lift proof (which also proves
    /// the note-spend nullifier's IMT non-membership + insert), CAS-advances the nullifier
    /// accumulator, and appends the bound `order_leaf` to the order-commitment tree. Relayer-
    /// submittable (the proof is the spend authority). There is NO on-chain matching here - a
    /// separate permissionless `settle_match` crosses resting orders. Order terms/tags come only
    /// from the verified public inputs; nothing the caller passes is trusted.
    pub fn place_order(env: Env, proof: Bytes, public_inputs: Bytes) -> Result<(), Error> {
        Self::verify_proof(&env, LIFT_OP, &proof, &public_inputs, LIFT_PUBLIC_INPUTS_BYTES)?;
        // Checks lift domain + published note_root, parses the bound order terms.
        let order = parse_order(&env, &public_inputs)?;
        // The order must name a registered canonical pair (reject unknown pairs early).
        let _ = pair_and_side(&env, order.asset_in, order.asset_out)?;
        // Advance the nullifier accumulator: [2] root_in must be current, [3] root_out becomes current.
        let nf_in = BytesN::from_array(&env, &read_word(&public_inputs, 64));
        let nf_out = BytesN::from_array(&env, &read_word(&public_inputs, 96));
        advance_nullifier_root(&env, &nf_in, &nf_out)?;
        NullifierSpent { nullifier: order.nullifier.clone() }.publish(&env);
        // Rest the order: append its leaf to the order tree.
        let h = Hasher::new(&env);
        order_insert(&env, &h, &order.order_leaf);
        bump_core(&env);
        Ok(())
    }

    /// Settle a match produced off-chain (permissionless). One match proof crosses 1 taker against up
    /// to 3 makers on one registered pair, minting up to 4 proceeds asset-notes (one per filled
    /// owner) and re-resting up to 1 remainder order. The proof binds the order-tree root the matched
    /// orders are members of, the nullifier-accumulator transition that consumes them, and every
    /// output leaf - so the contract only checks roots/time and inserts the bound leaves (matching
    /// trust lives in the verified circuit, not here). First valid match for the current accumulator
    /// root wins; a stale `nullifier_root_in` reverts cheaply. Outputs come only from verified PI.
    pub fn settle_match(env: Env, proof: Bytes, public_inputs: Bytes) -> Result<(), Error> {
        Self::verify_proof(&env, MATCH_OP, &proof, &public_inputs, MATCH_PUBLIC_INPUTS_BYTES)?;
        // [0] domain separator.
        if read_word(&public_inputs, 0) != MATCH_DOMAIN {
            return Err(Error::BadPublicInputs);
        }
        // [1] order_root must be an accepted order-tree root.
        let order_root = BytesN::from_array(&env, &read_word(&public_inputs, 32));
        if !tree_root_accepted(&env, TreeId::Order, &order_root) {
            return Err(Error::UnknownRoot);
        }
        // [4] now: the circuit asserts every matched order's expiry >= now; the contract binds now to
        // recent ledger time (allowing a small skew for proof-build/inclusion drift) so a matcher
        // cannot revive an expired order with a stale timestamp.
        let now = word_to_u64(&read_word(&public_inputs, 128))?;
        let current = env.ledger().timestamp();
        let max_skew: u64 = 300;
        if now > current || now + max_skew < current {
            return Err(Error::OrderExpired);
        }
        // [2],[3] CAS-advance the nullifier accumulator (consumption nullifiers proven in-circuit).
        let nf_in = BytesN::from_array(&env, &read_word(&public_inputs, 64));
        let nf_out = BytesN::from_array(&env, &read_word(&public_inputs, 96));
        advance_nullifier_root(&env, &nf_in, &nf_out)?;
        // [5..9] announce each consumed order nullifier for the indexer (0 = unused slot).
        let zero32 = BytesN::from_array(&env, &[0u8; 32]);
        let mut s = 5u32;
        while s < 9 {
            let nf = BytesN::from_array(&env, &read_word(&public_inputs, s * 32));
            if nf != zero32 {
                NullifierSpent { nullifier: nf }.publish(&env);
            }
            s += 1;
        }
        // [9..25] four proceeds slots {live, asset, amount, note_owner_tag}; mint the live ones.
        let h = Hasher::new(&env);
        let mut p = 0u32;
        while p < 4 {
            let base = (9 + p * 4) * 32;
            match word_to_u32(&read_word(&public_inputs, base))? {
                0 => {}
                1 => {
                    let asset = word_to_u32(&read_word(&public_inputs, base + 32))?;
                    let amount = word_to_i128(&read_word(&public_inputs, base + 64))?;
                    let tag = BytesN::from_array(&env, &read_word(&public_inputs, base + 96));
                    mint_note(&env, &h, asset, amount, &tag);
                }
                _ => return Err(Error::BadPublicInputs),
            }
            p += 1;
        }
        // [25],[26] remainder order: re-rest if live.
        match word_to_u32(&read_word(&public_inputs, 25 * 32))? {
            0 => {}
            1 => {
                let rem_leaf = BytesN::from_array(&env, &read_word(&public_inputs, 26 * 32));
                order_insert(&env, &h, &rem_leaf);
            }
            _ => return Err(Error::BadPublicInputs),
        }
        Matched { nullifier_root_out: nf_out }.publish(&env);
        bump_core(&env);
        Ok(())
    }

    /// Unshield: spend an asset note with a proof and transfer the real token out to `to`.
    /// The proof binds the withdrawal recipient (public input [7] == sha256-derived field of `to`),
    /// so a relayer can submit this without being able to redirect the funds. No caller auth is
    /// needed: the proof is the spend authority and the recipient is fixed by the proof.
    ///
    /// Public inputs: [0] domain [1] note_root [2] nf_root_in [3] nf_root_out [4] nullifier
    /// [5] asset [6] amount [7] recipient.
    pub fn unshield(
        env: Env,
        to: Address,
        proof_bytes: Bytes,
        public_inputs: Bytes,
    ) -> Result<(), Error> {
        Self::verify_proof(
            &env,
            UNSHIELD_OP,
            &proof_bytes,
            &public_inputs,
            UNSHIELD_PUBLIC_INPUTS_BYTES,
        )?;

        // [0] domain separator must be the unshield constant.
        if read_word(&public_inputs, 0) != UNSHIELD_DOMAIN {
            return Err(Error::BadPublicInputs);
        }
        // [1] note_root must be a published note-tree root.
        let root = BytesN::from_array(&env, &read_word(&public_inputs, 32));
        if !tree_root_accepted(&env, TreeId::Note, &root) {
            return Err(Error::UnknownRoot);
        }
        // [4] nullifier of the spent note (announced for the indexer; consumed via the IMT below).
        let nullifier = BytesN::from_array(&env, &read_word(&public_inputs, 128));
        // [5,6] withdrawal terms.
        let asset = word_to_u32(&read_word(&public_inputs, 160))?;
        let amount = word_to_i128(&read_word(&public_inputs, 192))?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        // [7] recipient binding: the proof must commit to exactly this payout address.
        if read_word(&public_inputs, 224) != recipient_field(&env, &to) {
            return Err(Error::RecipientMismatch);
        }

        let token: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Asset(asset))
            .ok_or(Error::AssetNotRegistered)?;

        // [2],[3] CAS-advance the nullifier accumulator BEFORE paying out (the non-membership +
        // insert was proven in-circuit; this single-use guard cannot be replayed). Then transfer.
        let nf_in = BytesN::from_array(&env, &read_word(&public_inputs, 64));
        let nf_out = BytesN::from_array(&env, &read_word(&public_inputs, 96));
        advance_nullifier_root(&env, &nf_in, &nf_out)?;
        NullifierSpent { nullifier: nullifier.clone() }.publish(&env);
        TokenClient::new(&env, &token).transfer(&env.current_contract_address(), &to, &amount);

        Unshielded { asset, amount, nullifier }.publish(&env);
        bump_core(&env);
        Ok(())
    }

    /// Join: consolidate two asset notes of the same asset into two fresh asset notes (a target and
    /// a change), entirely inside the shielded pool — no token movement. This is what lets a wallet
    /// assemble an exact denomination so the full-consumption `lift` order can offer a precise
    /// amount (e.g. merge 1.5 + 2 USDC into 3 + 0.5). Relayer-submittable (no caller auth: the join
    /// proof is the spend authority, exactly like `unshield`/`submit_order`).
    ///
    /// The proof (circuits/join) guarantees: both consumed notes are owned by one secret, are in the
    /// note tree at the published `note_root`, expose the two nullifiers, every amount is bounded, and
    /// value is conserved (`amount_1 + amount_2 == out_amount_1 + out_amount_2`, one asset). It also
    /// proves the IMT transition that consumes the nullifier(s) - the second insert is gated on the
    /// second input being real, and a null second input pins `nullifier_2 == 0`. The contract never
    /// sees the input amounts: it CAS-advances the accumulator and mints the two bound output leaves
    /// (a zero-amount output mints nothing, so this also serves as a plain 2->1 merge).
    ///
    /// Public inputs: [0] domain [1] note_root [2] nf_root_in [3] nf_root_out [4] nullifier_1
    /// [5] nullifier_2 [6] asset [7] out_tag_1 [8] out_amount_1 [9] out_tag_2 [10] out_amount_2.
    pub fn join(env: Env, proof: Bytes, public_inputs: Bytes) -> Result<(), Error> {
        Self::verify_proof(&env, JOIN_OP, &proof, &public_inputs, JOIN_PUBLIC_INPUTS_BYTES)?;

        // [0] domain separator must be the join constant.
        if read_word(&public_inputs, 0) != JOIN_DOMAIN {
            return Err(Error::BadPublicInputs);
        }
        // [1] note_root must be a published note-tree root.
        let root = BytesN::from_array(&env, &read_word(&public_inputs, 32));
        if !tree_root_accepted(&env, TreeId::Note, &root) {
            return Err(Error::UnknownRoot);
        }
        // [4],[5] the consumed-note nullifiers (announced for the indexer; nf2 == 0 means the second
        // input was a null padding note). Double-spend is prevented by the in-circuit IMT insert.
        let nf1 = BytesN::from_array(&env, &read_word(&public_inputs, 128));
        let nf2 = BytesN::from_array(&env, &read_word(&public_inputs, 160));
        // [6] asset (shared by inputs + outputs), [7..11] the two output notes the proof bound.
        let asset = word_to_u32(&read_word(&public_inputs, 192))?;
        let out_tag_1 = BytesN::from_array(&env, &read_word(&public_inputs, 224));
        let out_amount_1 = word_to_i128(&read_word(&public_inputs, 256))?;
        let out_tag_2 = BytesN::from_array(&env, &read_word(&public_inputs, 288));
        let out_amount_2 = word_to_i128(&read_word(&public_inputs, 320))?;

        // [2],[3] CAS-advance the nullifier accumulator BEFORE minting (single-use; proven in-circuit).
        let nf_in = BytesN::from_array(&env, &read_word(&public_inputs, 64));
        let nf_out = BytesN::from_array(&env, &read_word(&public_inputs, 96));
        advance_nullifier_root(&env, &nf_in, &nf_out)?;
        NullifierSpent { nullifier: nf1.clone() }.publish(&env);
        let zero32 = BytesN::from_array(&env, &[0u8; 32]);
        if nf2 != zero32 {
            NullifierSpent { nullifier: nf2.clone() }.publish(&env);
        }

        // Mint the two fresh asset notes into the tree. Value conservation is guaranteed by the
        // proof, so the contract simply mints the bound amounts; `mint_note` no-ops a zero output.
        let h = Hasher::new(&env);
        mint_note(&env, &h, asset, out_amount_1, &out_tag_1);
        mint_note(&env, &h, asset, out_amount_2, &out_tag_2);

        Joined { asset, nf1, nf2 }.publish(&env);
        bump_core(&env);
        Ok(())
    }

    /// Cancel a resting order and return its locked funds (permissionless / relayer-submittable). The
    /// cancel proof proves (a) the order is a member of an accepted order-tree root, (b) knowledge of
    /// the secret behind its `cancel_owner_tag`, and (c) the order-consumption nullifier's IMT
    /// non-membership + insert - so cancelling and matching race for the same order and whichever
    /// lands first blocks the other. The contract checks the order root, CAS-advances the nullifier
    /// accumulator, and mints the bound return note. Nothing the caller passes is trusted.
    ///
    /// Public inputs: [0] domain [1] order_root [2] nf_root_in [3] nf_root_out [4] order_nullifier
    /// [5] asset_in [6] amount_in [7] return_owner_tag.
    pub fn cancel_order(env: Env, proof: Bytes, public_inputs: Bytes) -> Result<(), Error> {
        Self::verify_proof(&env, CANCEL_OP, &proof, &public_inputs, CANCEL_PUBLIC_INPUTS_BYTES)?;
        // [0] domain.
        if read_word(&public_inputs, 0) != CANCEL_DOMAIN {
            return Err(Error::BadPublicInputs);
        }
        // [1] order_root must be an accepted order-tree root.
        let order_root = BytesN::from_array(&env, &read_word(&public_inputs, 32));
        if !tree_root_accepted(&env, TreeId::Order, &order_root) {
            return Err(Error::UnknownRoot);
        }
        // [4] order-consumption nullifier (announced for the indexer; consumed via the IMT below).
        let order_nullifier = BytesN::from_array(&env, &read_word(&public_inputs, 128));
        // [5,6] the order's locked asset + amount, [7] return destination.
        let asset_in = word_to_u32(&read_word(&public_inputs, 160))?;
        let amount_in = word_to_i128(&read_word(&public_inputs, 192))?;
        let return_owner_tag = BytesN::from_array(&env, &read_word(&public_inputs, 224));

        // [2],[3] CAS-advance the accumulator: an order can be matched OR cancelled exactly once.
        let nf_in = BytesN::from_array(&env, &read_word(&public_inputs, 64));
        let nf_out = BytesN::from_array(&env, &read_word(&public_inputs, 96));
        advance_nullifier_root(&env, &nf_in, &nf_out)?;
        NullifierSpent { nullifier: order_nullifier }.publish(&env);

        // Return the order's locked funds to the bound destination.
        let h = Hasher::new(&env);
        mint_note(&env, &h, asset_in, amount_in, &return_owner_tag);
        bump_core(&env);
        Ok(())
    }


    /// Permissionless storage heartbeat. Extends the TTL of all the BOUNDED structural state to the
    /// network maximum: the contract instance, both incremental-tree singletons + their current
    /// roots, the nullifier accumulator root, and the pair registry. A keeper calls this periodically
    /// so nothing ever archives in practice. (Unbounded sets - historical note/order roots - are
    /// bumped on write and can be refreshed individually via `keep_alive_keys`; archived entries
    /// remain restorable by anyone, so funds can never be lost regardless.)
    pub fn keep_alive(env: Env) {
        bump_core(&env);
        if let Some(pc) = env.storage().persistent().get::<DataKey, u32>(&DataKey::PairCount) {
            bump(&env, &DataKey::PairCount);
            let mut i = 0u32;
            while i < pc {
                bump(&env, &DataKey::Pair(i));
                i += 1;
            }
        }
    }

    /// Permissionless targeted heartbeat for the UNBOUNDED root histories: extend specific note-tree
    /// and order-tree root markers to the maximum TTL. Lets a keeper (or a user about to prove against
    /// an old root) refresh exactly the entries they care about. The nullifier accumulator is a single
    /// always-bumped root (covered by `bump_core`), so it needs no per-key refresh. Missing skipped.
    pub fn keep_alive_keys(env: Env, note_roots: Vec<BytesN<32>>, order_roots: Vec<BytesN<32>>) {
        for r in note_roots.iter() {
            let k = DataKey::Root(r);
            if env.storage().persistent().has(&k) {
                bump(&env, &k);
            }
        }
        for r in order_roots.iter() {
            let k = DataKey::OrderRoot(r);
            if env.storage().persistent().has(&k) {
                bump(&env, &k);
            }
        }
    }
}

impl Settlement {
    /// Verify a proof for `op` against its stored VK, after length-checking the proof and public
    /// inputs. Shared by `settle` (both sides) and `unshield`.
    fn verify_proof(
        env: &Env,
        op: u32,
        proof_bytes: &Bytes,
        public_inputs: &Bytes,
        expected_pi_bytes: u32,
    ) -> Result<(), Error> {
        if proof_bytes.len() as usize != PROOF_BYTES {
            return Err(Error::ProofParseError);
        }
        if public_inputs.len() != expected_pi_bytes {
            return Err(Error::BadPublicInputs);
        }
        let vk_bytes: Bytes = env
            .storage()
            .persistent()
            .get(&DataKey::Vk(op))
            .ok_or(Error::VkNotSet)?;
        let verifier = UltraHonkVerifier::new(env, &vk_bytes).map_err(|_| Error::VkInvalid)?;
        verifier
            .verify(env, proof_bytes, public_inputs)
            .map_err(|_| Error::VerificationFailed)?;
        Ok(())
    }

    /// Require the stored admin's authorization for a privileged call.
    fn require_admin(env: &Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::VkNotSet)?;
        admin.require_auth();
        Ok(())
    }
}

/// Extend a persistent entry's TTL to the network maximum. The entry must already exist. This is how
/// fund-critical state is kept live: persistent entries are never deleted (only archived, and
/// archived entries are restorable + cannot be silently read as absent), so bumping to max + the
/// permissionless `keep_alive`/restore backstop means data can never be lost and funds never stranded.
fn bump(env: &Env, key: &DataKey) {
    let max = env.storage().max_ttl();
    env.storage().persistent().extend_ttl(key, max, max);
}

/// Extend the contract instance (and its instance storage, e.g. the admin) TTL to the maximum.
fn bump_instance(env: &Env) {
    let max = env.storage().max_ttl();
    env.storage().instance().extend_ttl(max, max);
}

/// Refresh the always-present hot state every state-changing call touches: the instance, both
/// incremental-tree singletons + their current-root markers, and the nullifier accumulator root.
/// Cheap and bounded so it is safe even on the worst-case path. Unbounded sets (historical note/order
/// roots) are bumped on write and by `keep_alive`, and stay restorable.
fn bump_core(env: &Env) {
    bump_instance(env);
    bump(env, &DataKey::TreeFilled);
    bump(env, &DataKey::TreeNext);
    bump(env, &DataKey::TreeRoot);
    bump(env, &DataKey::OrderTreeFilled);
    bump(env, &DataKey::OrderTreeNext);
    bump(env, &DataKey::OrderTreeRoot);
    bump(env, &DataKey::NullifierRoot);
    // Keep each tree's latest root marker live (proofs bind a published root).
    if let Some(r) = env.storage().persistent().get::<DataKey, U256>(&DataKey::TreeRoot) {
        let rk = DataKey::Root(u256_to_bytesn(env, &r));
        if env.storage().persistent().has(&rk) {
            bump(env, &rk);
        }
    }
    if let Some(r) = env.storage().persistent().get::<DataKey, U256>(&DataKey::OrderTreeRoot) {
        let rk = DataKey::OrderRoot(u256_to_bytesn(env, &r));
        if env.storage().persistent().has(&rk) {
            bump(env, &rk);
        }
    }
}

/// Derive the canonical pair id and side for an order from its `(asset_in, asset_out)`. The pair's
/// orientation comes from its registered definition, never from the order, so an order's BUY/SELL is
/// well-defined regardless of how the user phrased it. SELL = give base / want quote (asset_in=base,
/// asset_out=quote); BUY = give quote / want base. Returns `PairNotRegistered` if `{asset_in,
/// asset_out}` is not a registered pair.
fn pair_and_side(env: &Env, asset_in: u32, asset_out: u32) -> Result<(u32, Side), Error> {
    let count: u32 = env.storage().persistent().get(&DataKey::PairCount).unwrap_or(0);
    let mut i = 0u32;
    while i < count {
        let p: PairDef = env.storage().persistent().get(&DataKey::Pair(i)).unwrap();
        if asset_in == p.base_asset && asset_out == p.quote_asset {
            return Ok((i, Side::Sell));
        }
        if asset_in == p.quote_asset && asset_out == p.base_asset {
            return Ok((i, Side::Buy));
        }
        i += 1;
    }
    Err(Error::PairNotRegistered)
}

/// Mint an asset note `(asset, amount, owner_tag)` into the note tree and announce it so the off-chain
/// indexer can rebuild its membership path. No-op for a zero amount. Single choke point for every
/// note payout (match proceeds, cancel returns). The `owner_tag` is the FINAL note tag (the per-note
/// nonce is already folded in by the circuit/wallet), so the contract never handles nonces.
fn mint_note(env: &Env, h: &Hasher, asset: u32, amount: i128, owner_tag: &BytesN<32>) {
    if amount <= 0 {
        return;
    }
    let leaf = asset_note_leaf(env, h, asset, amount, owner_tag);
    tree_insert(env, h, TreeId::Note, &leaf);
    NoteInserted { asset, amount, owner_tag: owner_tag.clone() }.publish(env);
}

/// Derive an order from a VERIFIED `lift` public-input blob (the WS4 14-field layout). Checks the lift
/// domain separator and that the membership `note_root` is published; parses the order terms the proof
/// bound. Caller must have verified the proof first (and reads the nullifier roots separately).
fn parse_order(env: &Env, pi: &Bytes) -> Result<Order, Error> {
    // [0] domain separator must be the order/lift constant.
    if read_word(pi, 0) != LIFT_DOMAIN {
        return Err(Error::BadPublicInputs);
    }
    // [1] note_root must be a published note-tree root.
    let root = BytesN::from_array(env, &read_word(pi, 32));
    if !tree_root_accepted(env, TreeId::Note, &root) {
        return Err(Error::UnknownRoot);
    }
    // [12] partial_allowed must be the boolean 0 or 1 (the circuit constrains it, but re-check).
    let partial_allowed = match word_to_u32(&read_word(pi, 384))? {
        0 => false,
        1 => true,
        _ => return Err(Error::BadPublicInputs),
    };
    Ok(Order {
        nullifier: BytesN::from_array(env, &read_word(pi, 128)), // [4]
        asset_in: word_to_u32(&read_word(pi, 160))?,             // [5]
        amount_in: word_to_i128(&read_word(pi, 192))?,           // [6]
        asset_out: word_to_u32(&read_word(pi, 224))?,            // [7]
        min_out: word_to_i128(&read_word(pi, 256))?,                    // [8]
        output_owner_tag: BytesN::from_array(env, &read_word(pi, 288)), // [9]
        cancel_owner_tag: BytesN::from_array(env, &read_word(pi, 320)), // [10]
        expiry: word_to_u64(&read_word(pi, 352))?,                      // [11]
        partial_allowed,                                                // [12]
        order_leaf: BytesN::from_array(env, &read_word(pi, 416)),       // [13]
    })
}

/// Deterministically map a payout address to the BN254 field the unshield proof must bind as its
/// recipient. We hash the address's XDR with sha256 and zero the top byte so the value is < 2^248
/// (safely below the field modulus). The wallet computes the identical value off-chain and bakes it
/// into the proof, so the contract can confirm the proof was made for exactly this `to`.
fn recipient_field(env: &Env, to: &Address) -> [u8; 32] {
    let h = env.crypto().sha256(&to.clone().to_xdr(env)).to_array();
    let mut w = [0u8; 32];
    let mut i = 1;
    while i < 32 {
        w[i] = h[i];
        i += 1;
    }
    w
}

/// Poseidon2 parameters (BN254 t=4) loaded once, then reused for every `compress` in an operation.
/// Building the round-constant tables (256 field elements) is expensive, so we must NOT rebuild
/// them per hash (a settle does ~68 compressions).
struct Hasher {
    m_diag: Vec<U256>,
    rc: Vec<Vec<U256>>,
    rounds_f: u32,
    rounds_p: u32,
    field: soroban_sdk::Symbol,
}

impl Hasher {
    fn new(env: &Env) -> Self {
        Hasher {
            m_diag: <Poseidon2Sponge<4, Bn254Fr> as Poseidon2Config<4, Bn254Fr>>::get_m_diag(env),
            rc: <Poseidon2Sponge<4, Bn254Fr> as Poseidon2Config<4, Bn254Fr>>::get_rc(env),
            rounds_f: <Poseidon2Sponge<4, Bn254Fr> as Poseidon2Config<4, Bn254Fr>>::ROUNDS_F,
            rounds_p: <Poseidon2Sponge<4, Bn254Fr> as Poseidon2Config<4, Bn254Fr>>::ROUNDS_P,
            field: <Bn254Fr as Field>::symbol(),
        }
    }

    /// 2-to-1 Poseidon2 compression, byte-identical to the circuits' `compress(a,b) =
    /// poseidon2_permutation([a,b,0,0],4)[0]`. This is what lets the on-chain Merkle tree produce
    /// the same leaves/nodes/roots the membership proofs are made against.
    fn compress(&self, env: &Env, a: &U256, b: &U256) -> U256 {
        let zero = U256::from_u32(env, 0);
        let input: Vec<U256> = vec![env, a.clone(), b.clone(), zero.clone(), zero];
        let out = env.crypto_hazmat().poseidon2_permutation(
            &input,
            self.field.clone(),
            POSEIDON_T,
            SBOX_D,
            self.rounds_f,
            self.rounds_p,
            &self.m_diag,
            &self.rc,
        );
        out.get_unchecked(0)
    }
}

/// U256 (field element) to a 32-byte big-endian word, matching the proofs' public-input encoding.
fn u256_to_bytesn(env: &Env, v: &U256) -> BytesN<32> {
    let mut buf = [0u8; 32];
    v.to_be_bytes().copy_into_slice(&mut buf);
    BytesN::from_array(env, &buf)
}

fn bytesn_to_u256(env: &Env, b: &BytesN<32>) -> U256 {
    U256::from_be_bytes(env, &Bytes::from_array(env, &b.to_array()))
}

/// AssetNote leaf = Poseidon(asset, amount, owner_tag), folded left-to-right like the circuit's
/// `hash3`. asset/amount are public field elements; owner_tag is a field element (32-byte word).
fn asset_note_leaf(env: &Env, h: &Hasher, asset: u32, amount: i128, owner_tag: &BytesN<32>) -> U256 {
    let a = U256::from_u32(env, asset);
    let m = U256::from_u128(env, amount as u128);
    let ot = bytesn_to_u256(env, owner_tag);
    let acc = h.compress(env, &a, &m);
    h.compress(env, &acc, &ot)
}

/// The hardcoded zero-subtree hash at level `i` as a field element.
fn zero_at(env: &Env, i: u32) -> U256 {
    U256::from_be_bytes(env, &Bytes::from_array(env, &TREE_ZEROS[i as usize]))
}

/// Which append-only tree a `tree_init`/`tree_insert` operates on. Both are depth-32 with the same
/// `TREE_ZEROS` ladder and `Hasher`; they differ only in their storage keys and accepted-root set.
#[derive(Copy, Clone)]
enum TreeId {
    Note,
    Order,
}

fn tk_filled(t: TreeId) -> DataKey {
    match t {
        TreeId::Note => DataKey::TreeFilled,
        TreeId::Order => DataKey::OrderTreeFilled,
    }
}
fn tk_next(t: TreeId) -> DataKey {
    match t {
        TreeId::Note => DataKey::TreeNext,
        TreeId::Order => DataKey::OrderTreeNext,
    }
}
fn tk_root(t: TreeId) -> DataKey {
    match t {
        TreeId::Note => DataKey::TreeRoot,
        TreeId::Order => DataKey::OrderTreeRoot,
    }
}
fn tk_accepted(t: TreeId, root: BytesN<32>) -> DataKey {
    match t {
        TreeId::Note => DataKey::Root(root),
        TreeId::Order => DataKey::OrderRoot(root),
    }
}

/// Is `root` an accepted (currently-or-formerly-current) root of tree `t`?
fn tree_root_accepted(env: &Env, t: TreeId, root: &BytesN<32>) -> bool {
    env.storage().persistent().has(&tk_accepted(t, root.clone()))
}

/// Initialize an append-only Merkle tree: filled subtrees start at the zeros (hardcoded), next
/// index 0, root = empty-tree root = compress(zeros[DEPTH-1], zeros[DEPTH-1]).
fn tree_init(env: &Env, h: &Hasher, t: TreeId) {
    let mut filled: Vec<U256> = vec![env];
    let mut i = 0u32;
    while i < TREE_DEPTH {
        filled.push_back(zero_at(env, i));
        i += 1;
    }
    let empty_root = {
        let z = zero_at(env, TREE_DEPTH - 1);
        h.compress(env, &z, &z)
    };
    env.storage().persistent().set(&tk_filled(t), &filled);
    env.storage().persistent().set(&tk_next(t), &0u32);
    // empty-tree root (not marked accepted: no leaf to prove).
    env.storage().persistent().set(&tk_root(t), &empty_root);
}

/// Insert a leaf (Tornado-style incremental update: TREE_DEPTH compressions up the rightmost path).
/// Advances the root and marks the new root accepted. Index bits are LSB-first; bit 0 => the
/// running node is the LEFT child (sibling = zeros[level]), matching the circuit's membership fold.
fn tree_insert(env: &Env, h: &Hasher, t: TreeId, leaf: &U256) -> U256 {
    let mut filled: Vec<U256> = env.storage().persistent().get(&tk_filled(t)).unwrap();
    let idx: u32 = env.storage().persistent().get(&tk_next(t)).unwrap();

    let mut cur = leaf.clone();
    let mut i = 0u32;
    while i < TREE_DEPTH {
        if (idx >> i) & 1 == 0 {
            filled.set(i, cur.clone());
            cur = h.compress(env, &cur, &zero_at(env, i));
        } else {
            let left = filled.get_unchecked(i);
            cur = h.compress(env, &left, &cur);
        }
        i += 1;
    }

    env.storage().persistent().set(&tk_filled(t), &filled);
    env.storage().persistent().set(&tk_next(t), &(idx + 1));
    env.storage().persistent().set(&tk_root(t), &cur);
    // Accept this root for membership proofs. Any past root stays accepted (the nullifier IMT
    // prevents double-spend regardless of root recency); bounded-ring eviction is a later refinement.
    env.storage()
        .persistent()
        .set(&tk_accepted(t, u256_to_bytesn(env, &cur)), &true);
    cur
}

/// The genesis root of the nullifier IMT: a single occupied leaf {0,0,0} at index 0, everything else
/// empty. fold(H3(0,0,0)) up the all-left path (sibling = zeros[i] at each level).
fn imt_genesis_root(env: &Env, h: &Hasher) -> U256 {
    let zero = U256::from_u32(env, 0);
    // H3(0,0,0) = compress(compress(0,0),0), matching the circuit's ImtLeaf::hash on {0,0,0}.
    let mut cur = h.compress(env, &h.compress(env, &zero, &zero), &zero);
    let mut i = 0u32;
    while i < TREE_DEPTH {
        cur = h.compress(env, &cur, &zero_at(env, i));
        i += 1;
    }
    cur
}

/// Read the current nullifier IMT root.
fn nullifier_root(env: &Env) -> U256 {
    env.storage().persistent().get(&DataKey::NullifierRoot).unwrap()
}

/// Verify a spend's nullifier-IMT transition and CAS-advance the accumulator: `root_in` must equal
/// the current root; on success the current root becomes `root_out`. The non-membership + insert was
/// already proven in-circuit, so the contract does no Poseidon here.
fn advance_nullifier_root(env: &Env, root_in: &BytesN<32>, root_out: &BytesN<32>) -> Result<(), Error> {
    let cur = nullifier_root(env);
    if u256_to_bytesn(env, &cur) != *root_in {
        return Err(Error::NullifierUsed);
    }
    env.storage()
        .persistent()
        .set(&DataKey::NullifierRoot, &bytesn_to_u256(env, root_out));
    bump(env, &DataKey::NullifierRoot);
    Ok(())
}

/// Append a leaf to the order-commitment tree and announce it for the indexer.
fn order_insert(env: &Env, h: &Hasher, order_leaf: &BytesN<32>) {
    tree_insert(env, h, TreeId::Order, &bytesn_to_u256(env, order_leaf));
    OrderInserted { order_leaf: order_leaf.clone() }.publish(env);
}

/// Copy the 32-byte big-endian word at byte `off` out of the public-input blob.
/// Callers must ensure `off + 32 <= public_inputs.len()` (verify_proof checks the total length).
fn read_word(pi: &Bytes, off: u32) -> [u8; 32] {
    let mut buf = [0u8; 32];
    pi.slice(off..off + 32).copy_into_slice(&mut buf);
    buf
}

/// Interpret a field-element word as a u32, rejecting anything that does not fit the low 4 bytes.
fn word_to_u32(w: &[u8; 32]) -> Result<u32, Error> {
    let mut i = 0;
    while i < 28 {
        if w[i] != 0 {
            return Err(Error::FieldOverflow);
        }
        i += 1;
    }
    Ok(u32::from_be_bytes([w[28], w[29], w[30], w[31]]))
}

/// Interpret a field-element word as a u64, rejecting anything that does not fit the low 8 bytes.
fn word_to_u64(w: &[u8; 32]) -> Result<u64, Error> {
    let mut i = 0;
    while i < 24 {
        if w[i] != 0 {
            return Err(Error::FieldOverflow);
        }
        i += 1;
    }
    let mut b = [0u8; 8];
    b.copy_from_slice(&w[24..32]);
    Ok(u64::from_be_bytes(b))
}

/// Interpret a field-element word as a non-negative i128, rejecting anything outside [0, 2^127).
fn word_to_i128(w: &[u8; 32]) -> Result<i128, Error> {
    let mut i = 0;
    while i < 16 {
        if w[i] != 0 {
            return Err(Error::FieldOverflow);
        }
        i += 1;
    }
    let mut b = [0u8; 16];
    b.copy_from_slice(&w[16..32]);
    let v = i128::from_be_bytes(b);
    if v < 0 {
        return Err(Error::FieldOverflow);
    }
    Ok(v)
}

#[cfg(test)]
mod orders_cross_tests {
    use super::{orders_cross, Order};
    use soroban_sdk::{BytesN, Env};

    fn order(env: &Env, asset_in: u32, amount_in: i128, asset_out: u32, min_out: i128) -> Order {
        Order {
            nullifier: BytesN::from_array(env, &[0u8; 32]),
            asset_in,
            amount_in,
            asset_out,
            min_out,
            output_owner_tag: BytesN::from_array(env, &[0u8; 32]),
            cancel_owner_tag: BytesN::from_array(env, &[0u8; 32]),
            expiry: 0,
            partial_allowed: false,
            order_leaf: BytesN::from_array(env, &[0u8; 32]),
        }
    }

    #[test]
    fn exact_reverse_crosses() {
        // A: sell 100 base, want >=2000 quote. B: buy (offer 2000 quote), want >=100 base.
        // a.min_out*b.min_out = 2000*100 = 200000 == a.amount_in*b.amount_in = 100*2000. Crosses (==).
        let env = Env::default();
        let a = order(&env, 1, 100, 2, 2000);
        let b = order(&env, 2, 2000, 1, 100);
        assert!(orders_cross(&env, &a, &b));
    }

    #[test]
    fn just_uncrossed_does_not_cross() {
        // A wants one more unit of quote than B is willing to give: 2001*100 > 100*2000.
        let env = Env::default();
        let a = order(&env, 1, 100, 2, 2001);
        let b = order(&env, 2, 2000, 1, 100);
        assert!(!orders_cross(&env, &a, &b));
    }

    #[test]
    fn favorable_prices_cross() {
        // A wants only 1500 quote for 100 base; B offers 2000 quote for 100 base. 1500*100 < 100*2000.
        let env = Env::default();
        let a = order(&env, 1, 100, 2, 1500);
        let b = order(&env, 2, 2000, 1, 100);
        assert!(orders_cross(&env, &a, &b));
    }

    #[test]
    fn large_values_do_not_overflow() {
        // Factors near 2^126: the i128 products (~2^252) would overflow, but the U256 path must not.
        let env = Env::default();
        let big = 1i128 << 126;
        // Equal cross-products -> crosses, exercises the boundary without panicking.
        let a = order(&env, 1, big, 2, big);
        let b = order(&env, 2, big, 1, big);
        assert!(orders_cross(&env, &a, &b));
        // Bump one limit so lhs > rhs at full scale; must still compute and return false.
        let a2 = order(&env, 1, big, 2, big);
        let b2 = order(&env, 2, big - 1, 1, big);
        assert!(!orders_cross(&env, &a2, &b2));
    }
}

#[cfg(test)]
mod hash_equivalence {
    use super::{zero_at, Hasher};
    use soroban_sdk::{testutils::Ledger, Env, U256};

    // Reference values from Noir's std::hash::poseidon2_permutation([a,b,0,0],4)[0]
    // (the circuits' `compress`). If these match, the on-chain tree hashes identically.
    #[test]
    fn compress_matches_circuit() {
        let env = Env::default();
        env.ledger().set_protocol_version(26);
        env.cost_estimate().budget().reset_unlimited();

        let one = U256::from_u32(&env, 1);
        let two = U256::from_u32(&env, 2);
        let zero = U256::from_u32(&env, 0);

        let h = Hasher::new(&env);
        let c12 = h.compress(&env, &one, &two);
        let expected_12 = U256::from_be_bytes(
            &env,
            &soroban_sdk::bytes!(
                &env,
                0x299bfccd7daf3c917e51291383929049ec0eaed800af245056cbf135f7dea636
            ),
        );
        assert_eq!(c12, expected_12, "compress(1,2) must match Noir");

        let c00 = h.compress(&env, &zero, &zero);
        let expected_00 = U256::from_be_bytes(
            &env,
            &soroban_sdk::bytes!(
                &env,
                0x18dfb8dc9b82229cff974efefc8df78b1ce96d9d844236b496785c698bc6732e
            ),
        );
        assert_eq!(c00, expected_00, "compress(0,0) must match Noir");

        // The hardcoded zeros ladder must match the live computation: zeros[1] = compress(0,0),
        // zeros[i+1] = compress(zeros[i], zeros[i]).
        assert_eq!(zero_at(&env, 0), zero, "zeros[0] = 0");
        let mut i = 0u32;
        while i < 31 {
            let zi = zero_at(&env, i);
            assert_eq!(
                zero_at(&env, i + 1),
                h.compress(&env, &zi, &zi),
                "hardcoded zeros ladder must match compress"
            );
            i += 1;
        }
    }
}
