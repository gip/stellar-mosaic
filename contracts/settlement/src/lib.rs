#![no_std]
//! Merged Desk + custody contract. Single contract owns custody, the nullifier registry, matching,
//! and settlement. See docs/architecture.md, docs/lift-circuit-spec.md.
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
//!             per-tx budget (see docs/tx-instruction-limit-spike.md).
//! `unshield`= spend an asset note with a proof and transfer the real token out, with the recipient
//!             bound into the proof so a relayer cannot redirect it.
//!
//! Order-proof public-input vector (lift circuit, 10 x 32-byte big-endian field elements):
//!   [0] domain  [1] root  [2] nullifier_in  [3] asset_in  [4] amount_in  [5] asset_out
//!   [6] min_out [7] output_owner_tag  [8] cancel_owner_tag  [9] order_leaf
//! settle uses [0..8]; cancel_owner_tag/order_leaf are unused here (no on-chain order note).

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, crypto::bn254::Bn254Fr, symbol_short,
    token::TokenClient, vec, xdr::ToXdr, Address, Bytes, BytesN, Env, Vec, U256,
};
use soroban_poseidon::{Field, Poseidon2Config, Poseidon2Sponge};
use ultrahonk_soroban_verifier::{UltraHonkVerifier, PROOF_BYTES};

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

/// Order-book limits. A pair has at most this many resting orders per side (buy / sell).
const BOOK_CAPACITY: u32 = 64;
/// Max fills a single `submit_order` performs before resting/IOC-returning the remainder. The cost
/// driver is proceeds inserts: each fill mints 2 asset notes (~2 depth-32 Poseidon chains), and on
/// testnet each insert is ~40M instructions (derived from `settle` = 230M and a 2-fill `submit_order`
/// = 220M). With the fixed verify (~80M), worst case ≈ 80M + (2*MAX_FILLS + 1 IOC)*40M + book
/// load/store. Book DEPTH is cheap (~58M local to load a full 64-deep side). The absolute worst case
/// (full 64-deep book + this many fills) is measured on testnet by
/// scripts/07_book_worstcase_testnet.sh. See docs/order-book.md.
const MAX_FILLS_PER_SUBMIT: u32 = 4;
/// Side encoding for `DataKey::Book(pair, side)`. Matches `Side`.
const SIDE_BUY: u32 = 0;
const SIDE_SELL: u32 = 1;

/// Public-input lengths for the order (lift) circuit and the unshield circuit.
const LIFT_PUBLIC_INPUTS_BYTES: u32 = 12 * 32;
const UNSHIELD_PUBLIC_INPUTS_BYTES: u32 = 6 * 32;
/// Domain separators as 32-byte big-endian field words: order/lift = 1, unshield = 2.
const LIFT_DOMAIN: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
];
const UNSHIELD_DOMAIN: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
];
/// Public-input length for the cancel circuit ([0]domain [1]order_leaf [2]cancel_owner_tag
/// [3]return_owner_tag) and its domain separator (=3).
const CANCEL_PUBLIC_INPUTS_BYTES: u32 = 4 * 32;
const CANCEL_DOMAIN: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
];
/// Public-input length for the join circuit ([0]domain [1]root [2]nullifier_1 [3]nullifier_2
/// [4]asset [5]out_tag_1 [6]out_amount_1 [7]out_tag_2 [8]out_amount_2) and its domain separator (=4).
const JOIN_PUBLIC_INPUTS_BYTES: u32 = 9 * 32;
const JOIN_DOMAIN: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4,
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
    Vk(u32), // verification key per operation (LIFT_OP / UNSHIELD_OP)
    Admin,
    Root(BytesN<32>), // set membership: this root was produced by the on-chain tree (accepted)
    Nullifier(BytesN<32>),
    Asset(u32), // asset id -> token contract Address
    TreeFilled, // Vec<U256> of length TREE_DEPTH: rightmost filled node per level
    TreeNext,   // u32: number of leaves inserted so far
    TreeRoot,   // U256: current tree root
    Pair(u32),  // pair id -> PairDef { base_asset, quote_asset } (canonical orientation)
    PairCount,  // u32: number of registered pairs (pair ids are 0..PairCount)
    Book(u32, u32), // (pair_id, side) -> Vec<OrderEntry>, kept sorted best-price-first (<=64)
}

/// A resting order in the on-chain book. Order *terms* are public (the privacy model only hides
/// owner identity), so the book stores them in plaintext. `asset_in`/`asset_out` are NOT stored —
/// they are derived from the order's `(pair_id, side)`. The conserved quantity is `remaining_in`:
/// units of the locked `asset_in` still held by the contract for this order. Every code path that
/// ends an order (fill-to-zero, cancel, prune, IOC) mints exactly the consumed/leftover `asset_in`
/// back out, so total minted + returned always equals the `amount_in` locked at submit.
#[contracttype]
#[derive(Clone)]
pub struct OrderEntry {
    pub amount_in: i128,   // original offered amount (fixes the limit price ratio with min_out)
    pub min_out: i128,     // original wanted amount (limit terms)
    pub remaining_in: i128, // locked asset_in still held (decreases as the order fills)
    pub output_owner_tag: BytesN<32>, // proceeds + IOC/prune return destination
    pub cancel_owner_tag: BytesN<32>, // cancel authority (cancel proof must know its secret)
    pub order_leaf: BytesN<32>,       // identity; the cancel proof references this
    pub expiry: u64,                  // validity deadline (unix seconds)
    pub partial_allowed: bool,        // may this order be partially filled
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
        tree_init(&env, &Hasher::new(&env));
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

    /// Read a book side (price-sorted, best first). Read-only view for clients/matchers; `side` is
    /// 0 = BUY, 1 = SELL.
    pub fn book(env: Env, pair_id: u32, side: u32) -> Vec<OrderEntry> {
        book_load(&env, pair_id, side)
    }

    /// Current on-chain Merkle tree root (the latest; any past root stays accepted too).
    pub fn root(env: Env) -> BytesN<32> {
        let r: U256 = env
            .storage()
            .persistent()
            .get(&DataKey::TreeRoot)
            .expect("tree initialized at construction");
        u256_to_bytesn(&env, &r)
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
        tree_insert(&env, &h, &leaf);
        env.events()
            .publish((symbol_short!("shielded"),), (asset_id, amount, owner_tag));
        bump_core(&env);
        Ok(())
    }

    /// Settle: an atomic two-sided trade in one transaction. The caller (an off-chain matcher)
    /// supplies both parties' order proofs. The contract verifies both, derives each order entirely
    /// from its verified public inputs (nothing the caller passes is trusted), checks they cross,
    /// records both nullifiers, and emits the proceeds descriptors stamped with each order's bound
    /// `output_owner_tag`. No on-chain order entries; no caller-supplied output commitments.
    pub fn settle(
        env: Env,
        proof_a: Bytes,
        public_inputs_a: Bytes,
        proof_b: Bytes,
        public_inputs_b: Bytes,
    ) -> Result<(), Error> {
        // Verify BOTH order proofs (~80M each; ~160M total fits the 400M per-tx budget).
        Self::verify_proof(&env, LIFT_OP, &proof_a, &public_inputs_a, LIFT_PUBLIC_INPUTS_BYTES)?;
        Self::verify_proof(&env, LIFT_OP, &proof_b, &public_inputs_b, LIFT_PUBLIC_INPUTS_BYTES)?;

        // Derive each side from its verified public inputs (domain + published-root checked here).
        let a = parse_order(&env, &public_inputs_a)?;
        let b = parse_order(&env, &public_inputs_b)?;

        // Assets must cross: A offers what B wants and vice versa.
        if a.asset_in != b.asset_out || a.asset_out != b.asset_in {
            return Err(Error::NotCompatible);
        }
        // Full-fill v1: each side receives the other's offered amount; both limits must be met.
        // A receives b.amount_in of a.asset_out; B receives a.amount_in of b.asset_out.
        if a.amount_in < b.min_out || b.amount_in < a.min_out {
            return Err(Error::NotCompatible);
        }
        // The two sides must be distinct notes (cannot cross a note against itself).
        if a.nullifier == b.nullifier {
            return Err(Error::NotCompatible);
        }

        // Both consumed notes must be unspent; record both nullifiers atomically before outputs.
        let ka = DataKey::Nullifier(a.nullifier.clone());
        let kb = DataKey::Nullifier(b.nullifier.clone());
        if env.storage().persistent().has(&ka) || env.storage().persistent().has(&kb) {
            return Err(Error::NullifierUsed);
        }
        env.storage().persistent().set(&ka, &true);
        env.storage().persistent().set(&kb, &true);
        bump(&env, &ka);
        bump(&env, &kb);

        // Proceeds: mint each side's asset note (asset_out, fill_amount, output_owner_tag) into the
        // on-chain tree, stamped from the bound tags. A receives b.amount_in of a.asset_out; B
        // receives a.amount_in of b.asset_out. The leaves are computed on-chain so the tree stays
        // canonical; the event lets the off-chain client rebuild paths.
        let h = Hasher::new(&env);
        let leaf_a = asset_note_leaf(&env, &h, a.asset_out, b.amount_in, &a.output_owner_tag);
        let leaf_b = asset_note_leaf(&env, &h, b.asset_out, a.amount_in, &b.output_owner_tag);
        tree_insert(&env, &h, &leaf_a);
        tree_insert(&env, &h, &leaf_b);

        env.events().publish(
            (symbol_short!("settled"),),
            (
                a.asset_out,
                b.amount_in,
                a.output_owner_tag,
                b.asset_out,
                a.amount_in,
                b.output_owner_tag,
            ),
        );
        bump_core(&env);
        Ok(())
    }

    /// Settle two orders that are EXACT reverses of each other, in one atomic transaction. This is
    /// the strict-equality sibling of `settle`: where `settle` accepts any crossing pair (limits met
    /// with `>=`), `settle_exact` requires each side to receive precisely what the other offered —
    /// `a.amount_in == b.min_out && b.amount_in == a.min_out` — so there is no surplus and no partial
    /// execution. Both assets must form a registered canonical pair, and the two sides must sit on
    /// opposite sides of it. Like `settle`, both proofs are verified, both orders are derived purely
    /// from their verified public inputs, both nullifiers are recorded, and the proceeds are minted
    /// into the tree from the bound `output_owner_tag`s.
    pub fn settle_exact(
        env: Env,
        proof_a: Bytes,
        public_inputs_a: Bytes,
        proof_b: Bytes,
        public_inputs_b: Bytes,
    ) -> Result<(), Error> {
        Self::verify_proof(&env, LIFT_OP, &proof_a, &public_inputs_a, LIFT_PUBLIC_INPUTS_BYTES)?;
        Self::verify_proof(&env, LIFT_OP, &proof_b, &public_inputs_b, LIFT_PUBLIC_INPUTS_BYTES)?;

        let a = parse_order(&env, &public_inputs_a)?;
        let b = parse_order(&env, &public_inputs_b)?;

        // Assets must cross AND form a registered canonical pair on opposite sides.
        let (pair_a, side_a) = pair_and_side(&env, a.asset_in, a.asset_out)?;
        let (pair_b, side_b) = pair_and_side(&env, b.asset_in, b.asset_out)?;
        if pair_a != pair_b || side_a == side_b {
            return Err(Error::NotCompatible);
        }
        // Exact reverse: each side receives precisely what the other offered (no surplus, no partial).
        if a.amount_in != b.min_out || b.amount_in != a.min_out {
            return Err(Error::NotCompatible);
        }
        // The two sides must be distinct notes (cannot cross a note against itself).
        if a.nullifier == b.nullifier {
            return Err(Error::NotCompatible);
        }

        let ka = DataKey::Nullifier(a.nullifier.clone());
        let kb = DataKey::Nullifier(b.nullifier.clone());
        if env.storage().persistent().has(&ka) || env.storage().persistent().has(&kb) {
            return Err(Error::NullifierUsed);
        }
        env.storage().persistent().set(&ka, &true);
        env.storage().persistent().set(&kb, &true);
        bump(&env, &ka);
        bump(&env, &kb);

        let h = Hasher::new(&env);
        let leaf_a = asset_note_leaf(&env, &h, a.asset_out, b.amount_in, &a.output_owner_tag);
        let leaf_b = asset_note_leaf(&env, &h, b.asset_out, a.amount_in, &b.output_owner_tag);
        tree_insert(&env, &h, &leaf_a);
        tree_insert(&env, &h, &leaf_b);

        env.events().publish(
            (symbol_short!("settled"),),
            (
                a.asset_out,
                b.amount_in,
                a.output_owner_tag,
                b.asset_out,
                a.amount_in,
                b.output_owner_tag,
            ),
        );
        bump_core(&env);
        Ok(())
    }

    /// Unshield: spend an asset note with a proof and transfer the real token out to `to`.
    /// The proof binds the withdrawal recipient (public input [5] == sha256-derived field of `to`),
    /// so a relayer can submit this without being able to redirect the funds. No caller auth is
    /// needed: the proof is the spend authority and the recipient is fixed by the proof.
    ///
    /// Public inputs: [0] domain [1] root [2] nullifier [3] asset [4] amount [5] recipient.
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
        // [1] root must be a published root.
        let root = BytesN::from_array(&env, &read_word(&public_inputs, 32));
        if !env.storage().persistent().has(&DataKey::Root(root)) {
            return Err(Error::UnknownRoot);
        }
        // [2] nullifier of the spent asset note: must be unused.
        let nullifier = BytesN::from_array(&env, &read_word(&public_inputs, 64));
        let nf_key = DataKey::Nullifier(nullifier.clone());
        if env.storage().persistent().has(&nf_key) {
            return Err(Error::NullifierUsed);
        }
        // [3..5] withdrawal terms.
        let asset = word_to_u32(&read_word(&public_inputs, 96))?;
        let amount = word_to_i128(&read_word(&public_inputs, 128))?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        // [5] recipient binding: the proof must commit to exactly this payout address.
        if read_word(&public_inputs, 160) != recipient_field(&env, &to) {
            return Err(Error::RecipientMismatch);
        }

        let token: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Asset(asset))
            .ok_or(Error::AssetNotRegistered)?;

        // Record the nullifier BEFORE paying out (single-use; spend cannot be replayed), then
        // transfer the public amount of the real token to the proof-bound recipient.
        env.storage().persistent().set(&nf_key, &true);
        bump(&env, &nf_key);
        TokenClient::new(&env, &token).transfer(&env.current_contract_address(), &to, &amount);

        env.events()
            .publish((symbol_short!("unshield"),), (asset, amount, nullifier));
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
    /// tree at the published `root`, expose the two nullifiers, every amount is bounded, and value is
    /// conserved (`amount_1 + amount_2 == out_amount_1 + out_amount_2`, one asset). The contract
    /// therefore never sees the input amounts: it records both nullifiers (single-use, must be
    /// distinct + unused) and mints exactly the two bound output leaves. A zero-amount output mints
    /// nothing (so this also serves as a plain 2->1 merge).
    pub fn join(env: Env, proof: Bytes, public_inputs: Bytes) -> Result<(), Error> {
        Self::verify_proof(&env, JOIN_OP, &proof, &public_inputs, JOIN_PUBLIC_INPUTS_BYTES)?;

        // [0] domain separator must be the join constant.
        if read_word(&public_inputs, 0) != JOIN_DOMAIN {
            return Err(Error::BadPublicInputs);
        }
        // [1] root must be a published root.
        let root = BytesN::from_array(&env, &read_word(&public_inputs, 32));
        if !env.storage().persistent().has(&DataKey::Root(root)) {
            return Err(Error::UnknownRoot);
        }
        // [2],[3] the two consumed-note nullifiers: must be distinct and both unused. Distinctness
        // matters because the has/set below is idempotent on equal keys — without this check a
        // single note could be passed twice and counted as two inputs (cf. `settle`).
        let nf1 = BytesN::from_array(&env, &read_word(&public_inputs, 64));
        let nf2 = BytesN::from_array(&env, &read_word(&public_inputs, 96));
        if nf1 == nf2 {
            return Err(Error::NotCompatible);
        }
        let k1 = DataKey::Nullifier(nf1.clone());
        let k2 = DataKey::Nullifier(nf2.clone());
        if env.storage().persistent().has(&k1) || env.storage().persistent().has(&k2) {
            return Err(Error::NullifierUsed);
        }
        // [4] asset (shared by inputs + outputs), [5..9] the two output notes the proof bound.
        let asset = word_to_u32(&read_word(&public_inputs, 128))?;
        let out_tag_1 = BytesN::from_array(&env, &read_word(&public_inputs, 160));
        let out_amount_1 = word_to_i128(&read_word(&public_inputs, 192))?;
        let out_tag_2 = BytesN::from_array(&env, &read_word(&public_inputs, 224));
        let out_amount_2 = word_to_i128(&read_word(&public_inputs, 256))?;

        // Record both nullifiers BEFORE minting (single-use spend authority; cannot be replayed).
        env.storage().persistent().set(&k1, &true);
        env.storage().persistent().set(&k2, &true);
        bump(&env, &k1);
        bump(&env, &k2);

        // Mint the two fresh asset notes into the tree. Value conservation is guaranteed by the
        // proof, so the contract simply mints the bound amounts; `mint_note` no-ops a zero output.
        let h = Hasher::new(&env);
        mint_note(&env, &h, asset, out_amount_1, &out_tag_1);
        mint_note(&env, &h, asset, out_amount_2, &out_tag_2);

        env.events()
            .publish((symbol_short!("joined"),), (asset, nf1, nf2));
        bump_core(&env);
        Ok(())
    }

    /// Submit an order to the on-chain book. Relayer-submittable (no caller auth: the lift proof is
    /// the spend authority, exactly like `unshield`). The proof locks the order's input note
    /// (records its nullifier). The incoming order is the *taker*: it is matched against the best
    /// opposing resting orders (price-time priority), executing at each maker's limit price in exact
    /// integer "lots" (the maker's reduced price ratio), honoring both orders' `partial_allowed`
    /// flags, minting proceeds notes per fill. Capped at `MAX_FILLS_PER_SUBMIT`. The unfilled
    /// remainder then rests (if `partial_allowed` and a slot is free) or is returned as a note (IOC).
    /// A taker that forbids partial execution and cannot fully fill reverts the whole transaction.
    pub fn submit_order(env: Env, proof: Bytes, public_inputs: Bytes) -> Result<(), Error> {
        Self::verify_proof(&env, LIFT_OP, &proof, &public_inputs, LIFT_PUBLIC_INPUTS_BYTES)?;
        let taker = parse_order(&env, &public_inputs)?; // checks lift domain + published root
        if taker.amount_in <= 0 || taker.min_out <= 0 {
            return Err(Error::InvalidAmount);
        }
        let now = env.ledger().timestamp();
        if taker.expiry < now {
            return Err(Error::OrderExpired);
        }
        // Lock the taker's input note before any output (single-use spend authority).
        let nf = DataKey::Nullifier(taker.nullifier.clone());
        if env.storage().persistent().has(&nf) {
            return Err(Error::NullifierUsed);
        }
        env.storage().persistent().set(&nf, &true);
        bump(&env, &nf);

        let (pair_id, taker_side) = pair_and_side(&env, taker.asset_in, taker.asset_out)?;
        let pair: PairDef = env.storage().persistent().get(&DataKey::Pair(pair_id)).unwrap();
        let h = Hasher::new(&env);

        let maker_is_sell = matches!(taker_side, Side::Buy); // maker sits on the opposite side
        let opp_u = if maker_is_sell { SIDE_SELL } else { SIDE_BUY };
        let mut book = book_load(&env, pair_id, opp_u);

        let mut remaining_in = taker.amount_in;
        let mut filled_out = 0i128; // total asset_out the taker receives across all fills
        let mut fills = 0u32;
        let mut i = 0u32;
        while i < book.len() && fills < MAX_FILLS_PER_SUBMIT && remaining_in > 0 {
            let mut maker = book.get(i).unwrap();
            if maker.expiry < now {
                i += 1; // expired: skip (prune_expired returns its funds); leave it resting
                continue;
            }
            // Price cross: once the best opposing maker doesn't cross, none further will (sorted).
            if !cross_amounts(&env, maker.amount_in, maker.min_out, taker.amount_in, taker.min_out) {
                break;
            }
            let (k_maker, k_taker, base_lot, quote_lot) =
                compute_lots(maker_is_sell, maker.amount_in, maker.min_out, maker.remaining_in, remaining_in);
            if k_taker == 0 {
                break; // taker cannot afford even one lot of the best remaining maker
            }
            if k_maker == 0 {
                i += 1; // maker has sub-lot dust remaining; skip it
                continue;
            }
            if !maker.partial_allowed && k_taker < k_maker {
                i += 1; // maker forbids partial fills and the taker cannot consume it whole; skip
                continue;
            }
            let k = if k_maker < k_taker { k_maker } else { k_taker };
            let f_base = k * base_lot;
            let q_quote = k * quote_lot;
            if maker_is_sell {
                // maker gives base -> taker; taker gives quote -> maker
                mint_note(&env, &h, pair.base_asset, f_base, &taker.output_owner_tag);
                mint_note(&env, &h, pair.quote_asset, q_quote, &maker.output_owner_tag);
                maker.remaining_in -= f_base;
                remaining_in -= q_quote;
                filled_out += f_base; // taker (BUY) receives base
            } else {
                // maker gives quote -> taker; taker gives base -> maker
                mint_note(&env, &h, pair.quote_asset, q_quote, &taker.output_owner_tag);
                mint_note(&env, &h, pair.base_asset, f_base, &maker.output_owner_tag);
                maker.remaining_in -= q_quote;
                remaining_in -= f_base;
                filled_out += q_quote; // taker (SELL) receives quote
            }
            fills += 1;
            if maker.remaining_in == 0 {
                book.remove(i); // consumed; next maker shifts into i (do not advance)
            } else {
                book.set(i, maker); // partially filled => taker is now exhausted; loop will end
            }
        }
        book_store(&env, pair_id, opp_u, &book);

        // If the order crossed, summarize the taker's trade in a single event so clients can show
        // "your order matched" with concrete amounts/currencies: `in` = asset_in spent on fills,
        // `out` = asset_out received. The per-note `noteins` mints still drive tree reconstruction;
        // this event is purely informational (indexers ignore unknown topics).
        let filled_in = taker.amount_in - remaining_in;
        if filled_in > 0 {
            env.events().publish(
                (symbol_short!("filled"),),
                (
                    taker.asset_in,
                    filled_in,
                    taker.asset_out,
                    filled_out,
                    taker.output_owner_tag.clone(),
                ),
            );
        }

        // Rest or IOC-return the taker's remainder.
        if remaining_in > 0 {
            if !taker.partial_allowed {
                return Err(Error::NotPartialAllowed); // fill-or-kill: revert the whole tx
            }
            let taker_u = side_to_u32(taker_side);
            let mut myside = book_load(&env, pair_id, taker_u);
            if myside.len() < BOOK_CAPACITY {
                let entry = OrderEntry {
                    amount_in: taker.amount_in,
                    min_out: taker.min_out,
                    remaining_in,
                    output_owner_tag: taker.output_owner_tag.clone(),
                    cancel_owner_tag: taker.cancel_owner_tag.clone(),
                    order_leaf: taker.order_leaf.clone(),
                    expiry: taker.expiry,
                    partial_allowed: taker.partial_allowed,
                };
                book_insert_sorted(&env, &mut myside, entry, taker_u);
                book_store(&env, pair_id, taker_u, &myside);
            } else {
                // Book full: immediate-or-cancel the remainder back to the order's destination.
                mint_note(&env, &h, taker.asset_in, remaining_in, &taker.output_owner_tag);
            }
        }
        bump_core(&env);
        Ok(())
    }

    /// Cancel a resting order and return its remaining locked funds. Relayer-submittable: the cancel
    /// proof proves knowledge of the order's `cancel_owner_tag` secret and binds both the order being
    /// cancelled (`order_leaf`) and the return destination (`return_owner_tag`), so no caller auth is
    /// needed and a relayer cannot retarget the funds. `pair_id`/`side` locate the book (a wrong hint
    /// simply fails to find the entry). Removing the entry is the single-use guard against replay.
    pub fn cancel_order(
        env: Env,
        pair_id: u32,
        side: u32,
        proof: Bytes,
        public_inputs: Bytes,
    ) -> Result<(), Error> {
        Self::verify_proof(&env, CANCEL_OP, &proof, &public_inputs, CANCEL_PUBLIC_INPUTS_BYTES)?;
        if read_word(&public_inputs, 0) != CANCEL_DOMAIN {
            return Err(Error::BadPublicInputs);
        }
        let order_leaf = BytesN::from_array(&env, &read_word(&public_inputs, 32));
        let cancel_owner_tag = BytesN::from_array(&env, &read_word(&public_inputs, 64));
        let return_owner_tag = BytesN::from_array(&env, &read_word(&public_inputs, 96));

        let (asset_in, _asset_out) = side_assets(&env, pair_id, side)?;
        let mut book = book_load(&env, pair_id, side);
        let mut i = 0u32;
        while i < book.len() {
            let e = book.get(i).unwrap();
            if e.order_leaf == order_leaf && e.cancel_owner_tag == cancel_owner_tag {
                let h = Hasher::new(&env);
                mint_note(&env, &h, asset_in, e.remaining_in, &return_owner_tag);
                book.remove(i);
                book_store(&env, pair_id, side, &book);
                bump_core(&env);
                return Ok(());
            }
            i += 1;
        }
        Err(Error::OrderNotFound)
    }

    /// Permissionlessly remove expired resting orders from a book side, returning each one's locked
    /// funds to its own bound `output_owner_tag`. Safe to be open to anyone: the destination is fixed
    /// by the order (set by its maker), not by the caller. `max` bounds the work per call.
    pub fn prune_expired(env: Env, pair_id: u32, side: u32, max: u32) -> Result<u32, Error> {
        let (asset_in, _asset_out) = side_assets(&env, pair_id, side)?;
        let now = env.ledger().timestamp();
        let h = Hasher::new(&env);
        let mut book = book_load(&env, pair_id, side);
        let mut removed = 0u32;
        let mut i = 0u32;
        while i < book.len() && removed < max {
            let e = book.get(i).unwrap();
            if e.expiry < now {
                mint_note(&env, &h, asset_in, e.remaining_in, &e.output_owner_tag);
                book.remove(i); // next shifts into i
                removed += 1;
            } else {
                i += 1;
            }
        }
        if removed > 0 {
            book_store(&env, pair_id, side, &book);
        }
        bump_core(&env);
        Ok(removed)
    }

    /// Permissionless storage heartbeat. Extends the TTL of all the BOUNDED structural state to the
    /// network maximum: the contract instance, the incremental-tree singletons + current root, the
    /// pair registry, and every pair's book sides. A keeper calls this periodically so nothing ever
    /// archives in practice. (Unbounded sets — historical roots and nullifiers — are bumped on write
    /// and can be refreshed individually via `keep_alive_keys`; archived entries remain restorable by
    /// anyone, so funds can never be lost regardless.)
    pub fn keep_alive(env: Env) {
        bump_core(&env);
        if let Some(pc) = env.storage().persistent().get::<DataKey, u32>(&DataKey::PairCount) {
            bump(&env, &DataKey::PairCount);
            let mut i = 0u32;
            while i < pc {
                bump(&env, &DataKey::Pair(i));
                let bk = DataKey::Book(i, SIDE_BUY);
                if env.storage().persistent().has(&bk) {
                    bump(&env, &bk);
                }
                let sk = DataKey::Book(i, SIDE_SELL);
                if env.storage().persistent().has(&sk) {
                    bump(&env, &sk);
                }
                i += 1;
            }
        }
    }

    /// Permissionless targeted heartbeat for the UNBOUNDED sets: extend specific nullifier and root
    /// entries to the maximum TTL. Lets a keeper (or a user about to spend an old note / prove against
    /// an old root) refresh exactly the entries they care about. Missing entries are skipped.
    pub fn keep_alive_keys(env: Env, nullifiers: Vec<BytesN<32>>, roots: Vec<BytesN<32>>) {
        for nf in nullifiers.iter() {
            let k = DataKey::Nullifier(nf);
            if env.storage().persistent().has(&k) {
                bump(&env, &k);
            }
        }
        for r in roots.iter() {
            let k = DataKey::Root(r);
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

/// Refresh the always-present hot state every state-changing call touches: the instance and the
/// incremental Merkle tree singletons, plus the current root's membership marker. Cheap and bounded
/// (≤5 TTL bumps) so it is safe even on `submit_order`'s worst-case path. Unbounded sets (historical
/// roots, nullifiers, per-pair books) are bumped on write and by `keep_alive`, and stay restorable.
fn bump_core(env: &Env) {
    bump_instance(env);
    bump(env, &DataKey::TreeFilled);
    bump(env, &DataKey::TreeNext);
    bump(env, &DataKey::TreeRoot);
    // Keep the latest root's set-membership marker live (proofs bind a published root).
    if let Some(r) = env.storage().persistent().get::<DataKey, U256>(&DataKey::TreeRoot) {
        let rk = DataKey::Root(u256_to_bytesn(env, &r));
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

/// Whether two opposite-side orders on the same pair cross (their limit prices overlap). With A the
/// SELL side (offers `a.amount_in` base, wants at least `a.min_out` quote) and B the BUY side (offers
/// `b.amount_in` quote, wants at least `b.min_out` base), A's floor price is `a.min_out / a.amount_in`
/// (quote per base) and B's ceiling is `b.amount_in / b.min_out`. They cross iff
/// `a.min_out/a.amount_in <= b.amount_in/b.min_out`, i.e. (cross-multiplied, all non-negative)
/// `a.min_out * b.min_out <= a.amount_in * b.amount_in`. Each factor is `< 2^127`, so the products
/// reach `~2^254` and must be computed in `U256` to avoid `i128` overflow. Caller must ensure the
/// assets actually cross and the SELL/BUY orientation matches A/B.
// Used by the Phase 2 matching engine; Phase 1 (`settle_exact`) uses strict equality directly.
#[allow(dead_code)]
fn orders_cross(env: &Env, a: &Order, b: &Order) -> bool {
    cross_amounts(env, a.amount_in, a.min_out, b.amount_in, b.min_out)
}

/// Core crossing predicate on raw amounts: two opposite-side orders cross iff their limit prices
/// overlap, i.e. `a.min_out * b.min_out <= a.amount_in * b.amount_in` (see `orders_cross`). Computed
/// in `U256` because each factor is `< 2^127` and the products reach `~2^254`.
fn cross_amounts(env: &Env, a_amount_in: i128, a_min_out: i128, b_amount_in: i128, b_min_out: i128) -> bool {
    let lhs = U256::from_u128(env, a_min_out as u128).mul(&U256::from_u128(env, b_min_out as u128));
    let rhs =
        U256::from_u128(env, a_amount_in as u128).mul(&U256::from_u128(env, b_amount_in as u128));
    lhs <= rhs
}

/// Greatest common divisor of two positive i128s (Euclid). Used to reduce a maker's price ratio
/// `amount_in : min_out` to its lowest terms, which defines the integer "lot" a match trades in.
fn gcd_i128(mut a: i128, mut b: i128) -> i128 {
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a
}

/// Decompose a match against `maker` into whole lots of the maker's reduced price ratio, so the trade
/// executes at EXACTLY the maker's limit price with no integer rounding (hence exact conservation).
/// A "lot" is `base_lot` base for `quote_lot` quote, where `base_lot:quote_lot = amount_in:min_out`
/// (maker SELL) or `min_out:amount_in` (maker BUY), reduced by their gcd. Returns how many lots the
/// maker's remaining locked balance allows (`k_maker`) and how many the taker's allows (`k_taker`);
/// the caller fills `min` of them (subject to the partial-execution flags). Requires positive amounts.
fn compute_lots(
    maker_is_sell: bool,
    m_amount_in: i128,
    m_min_out: i128,
    m_remaining_in: i128,
    taker_remaining_in: i128,
) -> (i128, i128, i128, i128) {
    let g = gcd_i128(m_amount_in, m_min_out);
    let (base_lot, quote_lot) = if maker_is_sell {
        (m_amount_in / g, m_min_out / g) // maker offers base, wants quote
    } else {
        (m_min_out / g, m_amount_in / g) // maker offers quote, wants base
    };
    // The maker's locked side is base (sell) or quote (buy); the taker's is the opposite.
    let (maker_lot, taker_lot) = if maker_is_sell {
        (base_lot, quote_lot)
    } else {
        (quote_lot, base_lot)
    };
    let k_maker = m_remaining_in / maker_lot;
    let k_taker = taker_remaining_in / taker_lot;
    (k_maker, k_taker, base_lot, quote_lot)
}

/// `Side` to its `DataKey::Book` discriminant.
fn side_to_u32(side: Side) -> u32 {
    match side {
        Side::Buy => SIDE_BUY,
        Side::Sell => SIDE_SELL,
    }
}

/// The `(asset_in, asset_out)` an order on `(pair_id, side)` locks / receives. SELL gives base for
/// quote; BUY gives quote for base. Errors if the pair is unregistered or `side` is not 0/1.
fn side_assets(env: &Env, pair_id: u32, side: u32) -> Result<(u32, u32), Error> {
    let pair: PairDef = env
        .storage()
        .persistent()
        .get(&DataKey::Pair(pair_id))
        .ok_or(Error::PairNotRegistered)?;
    match side {
        SIDE_SELL => Ok((pair.base_asset, pair.quote_asset)),
        SIDE_BUY => Ok((pair.quote_asset, pair.base_asset)),
        _ => Err(Error::PairNotRegistered),
    }
}

/// Mint an asset note `(asset, amount, owner_tag)` into the on-chain tree and announce it so the
/// off-chain indexer can rebuild its membership path. No-op for a zero amount. Single choke point for
/// every payout the book makes (fill proceeds, cancel/prune/IOC returns) — see the conservation note
/// on `OrderEntry`.
fn mint_note(env: &Env, h: &Hasher, asset: u32, amount: i128, owner_tag: &BytesN<32>) {
    if amount <= 0 {
        return;
    }
    let leaf = asset_note_leaf(env, h, asset, amount, owner_tag);
    tree_insert(env, h, &leaf);
    env.events()
        .publish((symbol_short!("noteins"),), (asset, amount, owner_tag.clone()));
}

/// Load a book side (price-sorted, best first), or an empty vector if none yet.
fn book_load(env: &Env, pair_id: u32, side: u32) -> Vec<OrderEntry> {
    env.storage()
        .persistent()
        .get(&DataKey::Book(pair_id, side))
        .unwrap_or_else(|| Vec::new(env))
}

/// Persist a book side and keep it live.
fn book_store(env: &Env, pair_id: u32, side: u32, book: &Vec<OrderEntry>) {
    let key = DataKey::Book(pair_id, side);
    env.storage().persistent().set(&key, book);
    bump(env, &key);
}

/// Is order `a` strictly ahead of `b` in priority for `side`? Asks (SELL) rank by ascending price
/// (lower `min_out/amount_in` first); bids (BUY) by descending price (higher `amount_in/min_out`
/// first). Ratios compared by `U256` cross-multiplication. Equal prices are NOT "better", so a new
/// order inserts after existing equal-price orders → price-then-time (FIFO) priority.
fn entry_better(env: &Env, a: &OrderEntry, b: &OrderEntry, side: u32) -> bool {
    if side == SIDE_SELL {
        // a.min_out/a.amount_in < b.min_out/b.amount_in
        let lhs = U256::from_u128(env, a.min_out as u128).mul(&U256::from_u128(env, b.amount_in as u128));
        let rhs = U256::from_u128(env, b.min_out as u128).mul(&U256::from_u128(env, a.amount_in as u128));
        lhs < rhs
    } else {
        // a.amount_in/a.min_out > b.amount_in/b.min_out
        let lhs = U256::from_u128(env, a.amount_in as u128).mul(&U256::from_u128(env, b.min_out as u128));
        let rhs = U256::from_u128(env, b.amount_in as u128).mul(&U256::from_u128(env, a.min_out as u128));
        lhs > rhs
    }
}

/// Insert `entry` into a price-sorted book side, preserving best-first + FIFO-on-tie ordering.
fn book_insert_sorted(env: &Env, book: &mut Vec<OrderEntry>, entry: OrderEntry, side: u32) {
    let mut pos = book.len();
    let mut j = 0u32;
    while j < book.len() {
        if entry_better(env, &entry, &book.get(j).unwrap(), side) {
            pos = j;
            break;
        }
        j += 1;
    }
    book.insert(pos, entry);
}

/// Derive one order side from a VERIFIED order-proof public-input blob. Checks the lift domain
/// separator and that the membership root is published; parses the order terms the proof bound.
/// Caller must have verified the proof first.
fn parse_order(env: &Env, pi: &Bytes) -> Result<Order, Error> {
    // [0] domain separator must be the order/lift constant.
    if read_word(pi, 0) != LIFT_DOMAIN {
        return Err(Error::BadPublicInputs);
    }
    // [1] root must be a published root.
    let root = BytesN::from_array(env, &read_word(pi, 32));
    if !env.storage().persistent().has(&DataKey::Root(root)) {
        return Err(Error::UnknownRoot);
    }
    // [10] partial_allowed must be the boolean 0 or 1 (the circuit constrains it, but re-check).
    let partial_word = read_word(pi, 320);
    let partial_allowed = match word_to_u32(&partial_word)? {
        0 => false,
        1 => true,
        _ => return Err(Error::BadPublicInputs),
    };
    Ok(Order {
        nullifier: BytesN::from_array(env, &read_word(pi, 64)),
        asset_in: word_to_u32(&read_word(pi, 96))?,
        amount_in: word_to_i128(&read_word(pi, 128))?,
        asset_out: word_to_u32(&read_word(pi, 160))?,
        min_out: word_to_i128(&read_word(pi, 192))?,
        output_owner_tag: BytesN::from_array(env, &read_word(pi, 224)),
        cancel_owner_tag: BytesN::from_array(env, &read_word(pi, 256)), // [8]
        expiry: word_to_u64(&read_word(pi, 288))?,                      // [9]
        partial_allowed,                                                // [10]
        order_leaf: BytesN::from_array(env, &read_word(pi, 352)),       // [11]
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

/// Initialize the append-only Merkle tree: filled subtrees start at the zeros (hardcoded), next
/// index 0, root = empty-tree root = compress(zeros[DEPTH-1], zeros[DEPTH-1]).
fn tree_init(env: &Env, h: &Hasher) {
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
    env.storage().persistent().set(&DataKey::TreeFilled, &filled);
    env.storage().persistent().set(&DataKey::TreeNext, &0u32);
    // empty-tree root (not marked accepted: no leaf to prove).
    env.storage().persistent().set(&DataKey::TreeRoot, &empty_root);
}

/// Insert a leaf (Tornado-style incremental update: TREE_DEPTH compressions up the rightmost path).
/// Advances the root and marks the new root accepted. Index bits are LSB-first; bit 0 => the
/// running node is the LEFT child (sibling = zeros[level]), matching the circuit's membership fold.
fn tree_insert(env: &Env, h: &Hasher, leaf: &U256) -> U256 {
    let mut filled: Vec<U256> = env.storage().persistent().get(&DataKey::TreeFilled).unwrap();
    let idx: u32 = env.storage().persistent().get(&DataKey::TreeNext).unwrap();

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

    env.storage().persistent().set(&DataKey::TreeFilled, &filled);
    env.storage().persistent().set(&DataKey::TreeNext, &(idx + 1));
    env.storage().persistent().set(&DataKey::TreeRoot, &cur);
    // Accept this root for membership proofs. Any past root stays accepted (nullifiers prevent
    // double-spend regardless of root recency); bounded-ring eviction is a later refinement.
    env.storage()
        .persistent()
        .set(&DataKey::Root(u256_to_bytesn(env, &cur)), &true);
    cur
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
