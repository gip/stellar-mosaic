//! Off-chain path server for the Stellar Mosaic note tree.
//!
//! The settlement contract maintains a depth-32 append-only Merkle tree on-chain, but stores only
//! the rightmost *filled subtrees* (enough to insert + advance the root), NOT every leaf. So the
//! chain has the canonical root, but no one can derive a membership path from it. This crate is the
//! missing piece: a read-only indexer that ingests the contract's `shielded`/`settled` events,
//! replays the exact same leaf insertions, and serves each note's Merkle path against the current
//! root so a wallet can generate an order (`circuits/lift`) or `circuits/unshield` proof.
//!
//! It is NOT a trust anchor — the on-chain root is. The indexer only reconstructs paths; the proof
//! it enables is checked on-chain against the on-chain root.
//!
//! ## Why this depends on a Soroban host
//!
//! The leaf/node hash is Poseidon2 (BN254, t=4), and the only implementation that is guaranteed
//! byte-identical to both the Noir circuits and the contract is the host function
//! `env.crypto_hazmat().poseidon2_permutation` with the `soroban-poseidon` BN254 t=4 constants. So
//! this off-chain tool instantiates a local Soroban host (`Env`) purely as a hashing engine and
//! reuses the contract's exact `compress`. There is deliberately no second, hand-ported Poseidon
//! here to drift out of sync.

use soroban_poseidon::{Field, Poseidon2Config, Poseidon2Sponge};
use soroban_sdk::{crypto::bn254::Bn254Fr, vec, Bytes, Env, Symbol, Vec, U256};

/// Poseidon2 S-box degree (BN254), fixed at 5 (the crate's `SBOX_D`).
const SBOX_D: u32 = 5;
/// Poseidon2 state width used by the circuits (t = 4, rate 3).
const POSEIDON_T: u32 = 4;
/// Depth of the append-only note tree (matches the contract's `TREE_DEPTH` and the circuits').
pub const TREE_DEPTH: usize = 32;

/// Poseidon2 parameters (BN254 t=4) loaded once and reused for every compression — mirrors the
/// contract's `Hasher`. Building the round-constant tables is expensive, so do it once.
#[derive(Clone)]
pub struct Hasher {
    m_diag: Vec<U256>,
    rc: Vec<Vec<U256>>,
    rounds_f: u32,
    rounds_p: u32,
    field: Symbol,
}

impl Hasher {
    pub fn new(env: &Env) -> Self {
        Hasher {
            m_diag: <Poseidon2Sponge<4, Bn254Fr> as Poseidon2Config<4, Bn254Fr>>::get_m_diag(env),
            rc: <Poseidon2Sponge<4, Bn254Fr> as Poseidon2Config<4, Bn254Fr>>::get_rc(env),
            rounds_f: <Poseidon2Sponge<4, Bn254Fr> as Poseidon2Config<4, Bn254Fr>>::ROUNDS_F,
            rounds_p: <Poseidon2Sponge<4, Bn254Fr> as Poseidon2Config<4, Bn254Fr>>::ROUNDS_P,
            field: <Bn254Fr as Field>::symbol(),
        }
    }

    /// 2-to-1 Poseidon2 compression, byte-identical to the circuits' `compress(a,b) =
    /// poseidon2_permutation([a,b,0,0],4)[0]` and the contract's `Hasher::compress`.
    pub fn compress(&self, env: &Env, a: &U256, b: &U256) -> U256 {
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

/// A 32-byte big-endian field word -> U256, matching the public-input / event encoding.
pub fn word_to_u256(env: &Env, w: &[u8; 32]) -> U256 {
    U256::from_be_bytes(env, &Bytes::from_array(env, w))
}

/// U256 -> 32-byte big-endian word.
pub fn u256_to_word(v: &U256) -> [u8; 32] {
    let mut buf = [0u8; 32];
    v.to_be_bytes().copy_into_slice(&mut buf);
    buf
}

/// AssetNote leaf = Poseidon(asset, amount, owner_tag), folded left-to-right like the circuit's
/// `hash3` and the contract's `asset_note_leaf`. asset/amount are public field elements;
/// owner_tag is a 32-byte field word.
pub fn asset_note_leaf(
    env: &Env,
    h: &Hasher,
    asset: u32,
    amount: i128,
    owner_tag: &[u8; 32],
) -> U256 {
    let a = U256::from_u32(env, asset);
    let m = U256::from_u128(env, amount as u128);
    let ot = word_to_u256(env, owner_tag);
    let acc = h.compress(env, &a, &m);
    h.compress(env, &acc, &ot)
}

/// A reconstructed membership path for one leaf, in the layout the `circuits/lift` and
/// `circuits/unshield` witnesses expect: `siblings`/`index_bits` are LSB-first (level 0 = leaf
/// level). `index_bits[i] == 0` means the running node is the LEFT child at level i.
pub struct MerklePath {
    pub leaf_index: usize,
    pub siblings: [U256; TREE_DEPTH],
    pub index_bits: [u8; TREE_DEPTH],
}

/// A full-leaf reconstruction of an on-chain append-only tree. Unlike the contract (which stores
/// only filled subtrees), this keeps every leaf so it can produce a path for ANY historical leaf.
/// Used for both the note tree and (via `insert_leaf`) the order-commitment tree, and as the backing
/// store for the nullifier IMT (which also needs in-place leaf updates).
#[derive(Clone)]
pub struct NoteTree {
    env: Env,
    h: Hasher,
    /// zeros[i] = empty-subtree hash at level i: zeros[0] = 0, zeros[i] = compress(zeros[i-1], same).
    zeros: std::vec::Vec<U256>,
    /// All leaves in on-chain insertion order.
    leaves: std::vec::Vec<U256>,
}

impl NoteTree {
    /// Build an empty tree. Computes the zero ladder from `compress` (the contract hardcodes the
    /// same ladder; the integration test checks they agree).
    pub fn new(env: &Env) -> Self {
        let h = Hasher::new(env);
        let mut zeros = std::vec::Vec::with_capacity(TREE_DEPTH);
        zeros.push(U256::from_u32(env, 0));
        for i in 1..TREE_DEPTH {
            let z = &zeros[i - 1];
            zeros.push(h.compress(env, z, z));
        }
        NoteTree {
            env: env.clone(),
            h,
            zeros,
            leaves: std::vec::Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.leaves.len()
    }

    pub fn is_empty(&self) -> bool {
        self.leaves.is_empty()
    }

    pub fn hasher(&self) -> &Hasher {
        &self.h
    }

    pub fn env(&self) -> &Env {
        &self.env
    }

    /// Append a precomputed leaf; returns its index.
    pub fn insert_leaf(&mut self, leaf: U256) -> usize {
        let idx = self.leaves.len();
        self.leaves.push(leaf);
        idx
    }

    /// Overwrite the leaf at `index` (used by the nullifier IMT to repoint a low leaf). Panics if
    /// `index >= len()`.
    pub fn set_leaf(&mut self, index: usize, leaf: U256) {
        self.leaves[index] = leaf;
    }

    /// Append an AssetNote leaf computed from its fields; returns its index.
    pub fn insert_asset_note(&mut self, asset: u32, amount: i128, owner_tag: &[u8; 32]) -> usize {
        let leaf = asset_note_leaf(&self.env, &self.h, asset, amount, owner_tag);
        self.insert_leaf(leaf)
    }

    /// Ingest a `shielded` event `(asset_id, amount, owner_tag)` — exactly one AssetNote leaf.
    /// Returns the new leaf's index.
    pub fn ingest_shielded(&mut self, asset_id: u32, amount: i128, owner_tag: &[u8; 32]) -> usize {
        self.insert_asset_note(asset_id, amount, owner_tag)
    }

    /// Ingest a `noteins` event `(asset, amount, owner_tag)` — one AssetNote leaf minted by a
    /// `settle_match` proceeds payout or a `cancel_order` return. One event per inserted leaf, in
    /// insertion order, so replaying them rebuilds the note tree just like `shielded`. The `owner_tag`
    /// here is the FINAL note tag (the per-note nonce already folded in by the circuit). Returns the
    /// new leaf's index.
    pub fn ingest_note(&mut self, asset: u32, amount: i128, owner_tag: &[u8; 32]) -> usize {
        self.insert_asset_note(asset, amount, owner_tag)
    }

    /// Ingest an `orderins` event into the ORDER tree: the leaf is the order's `order_leaf` (= H8 of
    /// its terms), supplied directly by the event, so we append it as-is. (Use a separate `NoteTree`
    /// instance for the order tree.) Returns the new leaf's index.
    pub fn ingest_orderins(&mut self, order_leaf: &[u8; 32]) -> usize {
        self.insert_leaf(word_to_u256(&self.env, order_leaf))
    }

    /// Ingest a `settled` event. The contract emits, and inserts, in this order:
    ///   leaf_a = AssetNote(a.asset_out, b.amount_in, a.output_owner_tag)   (inserted first)
    ///   leaf_b = AssetNote(b.asset_out, a.amount_in, b.output_owner_tag)   (inserted second)
    /// matching the event tuple `(a_asset_out, b_amount_in, a_tag, b_asset_out, a_amount_in, b_tag)`.
    /// Returns the two new leaf indices in insertion order.
    #[allow(clippy::too_many_arguments)]
    pub fn ingest_settled(
        &mut self,
        a_asset_out: u32,
        b_amount_in: i128,
        a_output_owner_tag: &[u8; 32],
        b_asset_out: u32,
        a_amount_in: i128,
        b_output_owner_tag: &[u8; 32],
    ) -> (usize, usize) {
        let ia = self.insert_asset_note(a_asset_out, b_amount_in, a_output_owner_tag);
        let ib = self.insert_asset_note(b_asset_out, a_amount_in, b_output_owner_tag);
        (ia, ib)
    }

    /// Get a leaf value by index.
    pub fn leaf(&self, index: usize) -> Option<U256> {
        self.leaves.get(index).cloned()
    }

    /// Build all tree levels from the current leaves. `layers[0]` is the leaf level; `layers[i+1]`
    /// is built by compressing pairs of `layers[i]`, padding an odd tail with `zeros[i]`.
    fn build_layers(&self) -> std::vec::Vec<std::vec::Vec<U256>> {
        let mut layers: std::vec::Vec<std::vec::Vec<U256>> =
            std::vec::Vec::with_capacity(TREE_DEPTH + 1);
        layers.push(self.leaves.clone());
        for level in 0..TREE_DEPTH {
            let prev = &layers[level];
            let n = prev.len();
            let mut cur = std::vec::Vec::with_capacity(n.div_ceil(2));
            let mut i = 0;
            while i < n {
                let left = prev[i].clone();
                let right = if i + 1 < n {
                    prev[i + 1].clone()
                } else {
                    self.zeros[level].clone()
                };
                cur.push(self.h.compress(&self.env, &left, &right));
                i += 2;
            }
            layers.push(cur);
        }
        layers
    }

    /// Current Merkle root — must equal the contract's `root()` after the same inserts.
    pub fn root(&self) -> U256 {
        if self.leaves.is_empty() {
            // Empty-tree root = compress(zeros[DEPTH-1], zeros[DEPTH-1]), matching the contract.
            let z = &self.zeros[TREE_DEPTH - 1];
            return self.h.compress(&self.env, z, z);
        }
        let layers = self.build_layers();
        layers[TREE_DEPTH][0].clone()
    }

    /// Membership path for the leaf at `index`. `index == len()` is allowed and yields the path for
    /// the next (empty) append slot — the nullifier IMT needs this to witness where a new leaf lands.
    pub fn path(&self, index: usize) -> MerklePath {
        assert!(index <= self.leaves.len(), "leaf index out of range");
        let layers = self.build_layers();
        // Arrays are filled level by level; start from the zero word and overwrite.
        let zero = U256::from_u32(&self.env, 0);
        let mut siblings: [U256; TREE_DEPTH] = core::array::from_fn(|_| zero.clone());
        let mut index_bits = [0u8; TREE_DEPTH];
        let mut idx = index;
        for level in 0..TREE_DEPTH {
            let bit = (idx & 1) as u8;
            let sib_pos = idx ^ 1;
            let layer = &layers[level];
            let sib = layer
                .get(sib_pos)
                .cloned()
                .unwrap_or_else(|| self.zeros[level].clone());
            siblings[level] = sib;
            index_bits[level] = bit;
            idx >>= 1;
        }
        MerklePath {
            leaf_index: index,
            siblings,
            index_bits,
        }
    }

    /// Fold a leaf up a path with the EXACT algorithm the Noir membership circuit uses:
    ///   bit == 0 => node is left child (sibling on the right); bit == 1 => node is right child.
    /// If this returns `root()` for a `path(index)`, a proof built with that witness will satisfy
    /// the circuit's membership constraint. This is how we verify paths without running bb.
    pub fn circuit_fold(&self, leaf: &U256, path: &MerklePath) -> U256 {
        let mut node = leaf.clone();
        for level in 0..TREE_DEPTH {
            let sib = &path.siblings[level];
            let (left, right) = if path.index_bits[level] == 0 {
                (node.clone(), sib.clone())
            } else {
                (sib.clone(), node.clone())
            };
            node = self.h.compress(&self.env, &left, &right);
        }
        node
    }
}

/// Render a U256 as a `0x`-prefixed 64-hex-digit string for a Noir `Prover.toml` Field value.
pub fn u256_hex(v: &U256) -> String {
    let w = u256_to_word(v);
    let mut s = String::with_capacity(66);
    s.push_str("0x");
    for b in w.iter() {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Order leaf = H8(asset_in, amount_in, asset_out, min_out, output_owner_tag, cancel_owner_tag,
/// expiry, partial_allowed), folded left-to-right like the circuit's `hash8` / the contract's order
/// leaf. Lets the indexer verify an `orderins` event's leaf against its emitted terms.
#[allow(clippy::too_many_arguments)]
pub fn order_leaf(
    env: &Env,
    h: &Hasher,
    asset_in: u32,
    amount_in: i128,
    asset_out: u32,
    min_out: i128,
    output_owner_tag: &[u8; 32],
    cancel_owner_tag: &[u8; 32],
    expiry: u64,
    partial_allowed: bool,
) -> U256 {
    let mut acc = h.compress(
        env,
        &U256::from_u32(env, asset_in),
        &U256::from_u128(env, amount_in as u128),
    );
    acc = h.compress(env, &acc, &U256::from_u32(env, asset_out));
    acc = h.compress(env, &acc, &U256::from_u128(env, min_out as u128));
    acc = h.compress(env, &acc, &word_to_u256(env, output_owner_tag));
    acc = h.compress(env, &acc, &word_to_u256(env, cancel_owner_tag));
    acc = h.compress(env, &acc, &U256::from_u128(env, expiry as u128));
    h.compress(env, &acc, &U256::from_u32(env, partial_allowed as u32))
}

/// Domain separator for order-consumption nullifiers (matches the circuits' `ORDER_NULLIFIER_DOMAIN`).
pub const ORDER_NULLIFIER_DOMAIN: u32 = 7;

/// Order-consumption nullifier = compress(ORDER_NULLIFIER_DOMAIN, order_leaf). The frontend computes
/// this to test a leaf against `nfspent` (active vs. consumed); the witness bin uses it to drive the
/// IMT on a match/cancel.
pub fn order_consumption_nullifier(env: &Env, h: &Hasher, order_leaf: &U256) -> U256 {
    h.compress(env, &U256::from_u32(env, ORDER_NULLIFIER_DOMAIN), order_leaf)
}

/// One leaf of the indexed merkle tree: a node in the sorted singly-linked list of consumed values.
#[derive(Clone)]
pub struct ImtLeaf {
    pub value: U256,
    pub next_value: U256,
    pub next_index: u64,
}

/// IMT leaf hash = H3(value, next_value, next_index), matching the circuit's `ImtLeaf::hash`.
pub fn imt_leaf_hash(env: &Env, h: &Hasher, leaf: &ImtLeaf) -> U256 {
    let acc = h.compress(env, &leaf.value, &leaf.next_value);
    h.compress(env, &acc, &U256::from_u128(env, leaf.next_index as u128))
}

/// The witnesses a spend circuit's `imt_insert` needs to consume `value`, plus the resulting root.
pub struct ImtWitness {
    pub low_value: U256,
    pub low_next_value: U256,
    pub low_next_index: u64,
    pub low_path: MerklePath,
    pub new_path: MerklePath,
    /// Append-frontier proof: the leaf at `new_index - 1` and its path in the intermediate root
    /// (after the low-leaf repoint, before the new leaf is written). Pins `new_index` to the append
    /// frontier so the circuit cannot insert into a gap. `pred_path.index_bits` is `pred_index_bits`.
    pub pred_leaf: U256,
    pub pred_path: MerklePath,
    pub root_out: U256,
}

/// A full reconstruction of the nullifier accumulator (indexed merkle tree). Maintains the sorted
/// linked list + the backing depth-32 tree, replays consumed nullifiers (`nfspent`) to stay in sync
/// with the on-chain `NullifierRoot`, and produces low-leaf witnesses for the next spender. The
/// genesis state is a single {0,0,0} leaf at index 0 (matches the contract's `imt_genesis_root`).
#[derive(Clone)]
pub struct NullifierImt {
    tree: NoteTree,
    leaves: std::vec::Vec<ImtLeaf>,
}

impl NullifierImt {
    pub fn new(env: &Env) -> Self {
        let mut tree = NoteTree::new(env);
        let zero = U256::from_u32(env, 0);
        let genesis = ImtLeaf { value: zero.clone(), next_value: zero, next_index: 0 };
        let hsh = imt_leaf_hash(env, tree.hasher(), &genesis);
        tree.insert_leaf(hsh);
        NullifierImt { tree, leaves: std::vec![genesis] }
    }

    pub fn root(&self) -> U256 {
        self.tree.root()
    }

    /// Number of occupied leaves (>= 1, the genesis leaf is always present).
    pub fn leaf_count(&self) -> usize {
        self.leaves.len()
    }

    /// Index of the low leaf for `value`: the L with L.value < value < L.next_value, or L.value <
    /// value and L.next_value == 0 (L is the current max). Panics if `value` is already present.
    fn find_low(&self, value: &U256) -> usize {
        let zero = U256::from_u32(self.tree.env(), 0);
        for (i, l) in self.leaves.iter().enumerate() {
            let is_max = l.next_value == zero;
            if l.value < *value && (is_max || *value < l.next_value) {
                return i;
            }
        }
        panic!("no low leaf for value (already present or invalid)");
    }

    /// Compute the witness for inserting `value` AND apply it (advance the accumulator). Use when
    /// replaying an observed `nfspent` event.
    pub fn insert(&mut self, value: U256) -> ImtWitness {
        let env = self.tree.env().clone();
        let low_idx = self.find_low(&value);
        let low = self.leaves[low_idx].clone();
        let low_path = self.tree.path(low_idx);
        let new_index = self.tree.len();
        // repoint the low leaf at the new node -> tree now at intermediate root r1.
        let updated_low = ImtLeaf {
            value: low.value.clone(),
            next_value: value.clone(),
            next_index: new_index as u64,
        };
        let updated_low_hash = imt_leaf_hash(&env, self.tree.hasher(), &updated_low);
        self.tree.set_leaf(low_idx, updated_low_hash);
        self.leaves[low_idx] = updated_low;
        // the new slot's path in r1 (the empty append slot at new_index).
        let new_path = self.tree.path(new_index);
        // append-frontier proof: the occupied leaf immediately left of the append slot, in r1. Since
        // new_index == tree.len(), the predecessor is the last occupied leaf (possibly the just-
        // repointed low leaf). Both reads are against the current (r1) tree state.
        let pred_index = new_index - 1;
        let pred_leaf = imt_leaf_hash(&env, self.tree.hasher(), &self.leaves[pred_index]);
        let pred_path = self.tree.path(pred_index);
        // write the new leaf, splicing it after the low leaf.
        let new_leaf = ImtLeaf {
            value,
            next_value: low.next_value.clone(),
            next_index: low.next_index,
        };
        let new_leaf_hash = imt_leaf_hash(&env, self.tree.hasher(), &new_leaf);
        self.tree.insert_leaf(new_leaf_hash);
        self.leaves.push(new_leaf);
        ImtWitness {
            low_value: low.value,
            low_next_value: low.next_value,
            low_next_index: low.next_index,
            low_path,
            new_path,
            pred_leaf,
            pred_path,
            root_out: self.tree.root(),
        }
    }

    /// Compute the witness for inserting `value` WITHOUT applying it — for a spender building a proof
    /// against the current on-chain root (the real insert lands when its `nfspent` is later observed).
    pub fn witness(&self, value: U256) -> ImtWitness {
        let mut clone = self.clone();
        clone.insert(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{bytesn, Env};

    fn env() -> Env {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        env
    }

    /// The compression MUST match Noir's `poseidon2_permutation([a,b,0,0],4)[0]` and the contract's
    /// hardcoded values. Same known-answer vectors the contract unit-tests against.
    #[test]
    fn compress_matches_circuit_and_contract() {
        let env = env();
        let h = Hasher::new(&env);
        let one = U256::from_u32(&env, 1);
        let two = U256::from_u32(&env, 2);
        let zero = U256::from_u32(&env, 0);

        let c12 = h.compress(&env, &one, &two);
        let exp12 = U256::from_be_bytes(
            &env,
            &bytesn!(
                &env,
                0x299bfccd7daf3c917e51291383929049ec0eaed800af245056cbf135f7dea636
            )
            .into(),
        );
        assert_eq!(c12, exp12, "compress(1,2) must match Noir/contract");

        let c00 = h.compress(&env, &zero, &zero);
        let exp00 = U256::from_be_bytes(
            &env,
            &bytesn!(
                &env,
                0x18dfb8dc9b82229cff974efefc8df78b1ce96d9d844236b496785c698bc6732e
            )
            .into(),
        );
        assert_eq!(c00, exp00, "compress(0,0) must match Noir/contract");
    }

    /// The zero ladder this crate computes must match the contract's hardcoded TREE_ZEROS, spot
    /// checked at zeros[1] = compress(0,0) and zeros[2] = compress(zeros[1], zeros[1]).
    #[test]
    fn zero_ladder_matches_contract() {
        let env = env();
        let tree = NoteTree::new(&env);
        assert_eq!(tree.zeros[0], U256::from_u32(&env, 0));
        let z1 = U256::from_be_bytes(
            &env,
            &bytesn!(
                &env,
                0x18dfb8dc9b82229cff974efefc8df78b1ce96d9d844236b496785c698bc6732e
            )
            .into(),
        );
        assert_eq!(tree.zeros[1], z1, "zeros[1] = compress(0,0)");
        let z2 = U256::from_be_bytes(
            &env,
            &bytesn!(
                &env,
                0x2c0d184fc7a25c124a27a67b2c46220b039b1a5072c3b693a18ffee458f6425d
            )
            .into(),
        );
        assert_eq!(tree.zeros[2], z2, "zeros[2] = compress(zeros[1], zeros[1])");
    }

    /// Every inserted leaf's reconstructed path must fold (with the circuit algorithm) back to the
    /// current root, after each insert — this is the core path-server guarantee.
    #[test]
    fn paths_fold_to_root_for_all_leaves() {
        let env = env();
        let mut tree = NoteTree::new(&env);
        let tags: [[u8; 32]; 5] = core::array::from_fn(|i| {
            let mut t = [0u8; 32];
            t[31] = (i as u8) + 1;
            t
        });
        // A mix of shields and a settle, growing the tree to 5 leaves (indices 0..5).
        tree.ingest_shielded(1, 100, &tags[0]);
        tree.ingest_shielded(2, 2000, &tags[1]);
        tree.ingest_settled(2, 2000, &tags[2], 1, 100, &tags[3]); // -> leaves 2,3
        tree.ingest_shielded(1, 50, &tags[4]); // -> leaf 4
        assert_eq!(tree.len(), 5);

        let root = tree.root();
        for i in 0..tree.len() {
            let leaf = tree.leaf(i).unwrap();
            let p = tree.path(i);
            assert_eq!(p.leaf_index, i);
            assert_eq!(
                tree.circuit_fold(&leaf, &p),
                root,
                "leaf {i} path must fold to the root"
            );
        }
    }

    /// The order tree reuses the append-tree machinery: an `orderins` leaf is inserted verbatim and
    /// its path folds back to the order root, exactly like the note tree.
    #[test]
    fn order_tree_paths_fold_to_root() {
        let env = env();
        let h = Hasher::new(&env);
        let mut order_tree = NoteTree::new(&env);
        // Two orders with distinct terms -> distinct leaves.
        let l0 = order_leaf(&env, &h, 1, 100, 2, 1500, &[1u8; 32], &[2u8; 32], 9999, true);
        let l1 = order_leaf(&env, &h, 2, 2400, 1, 100, &[3u8; 32], &[4u8; 32], 9999, false);
        order_tree.ingest_orderins(&u256_to_word(&l0));
        order_tree.ingest_orderins(&u256_to_word(&l1));
        let root = order_tree.root();
        for i in 0..order_tree.len() {
            let leaf = order_tree.leaf(i).unwrap();
            assert_eq!(order_tree.circuit_fold(&leaf, &order_tree.path(i)), root);
        }
    }

    /// IMT witnesses must satisfy the circuit's `imt_insert`: the low leaf is a member of `root_in`,
    /// and applying advances to the predicted `root_out`. Inserts out of order (5,9,3,7) to exercise
    /// mid-range and append-at-max low-leaf selection.
    #[test]
    fn imt_witnesses_are_consistent() {
        let env = env();
        let h = Hasher::new(&env);
        let mut imt = NullifierImt::new(&env);
        for k in [5u32, 9, 3, 7] {
            let v = U256::from_u32(&env, k);
            let root_in = imt.root();
            // non-mutating witness used by a spender proving against the current root.
            let w = imt.witness(v.clone());
            let low = ImtLeaf {
                value: w.low_value.clone(),
                next_value: w.low_next_value.clone(),
                next_index: w.low_next_index,
            };
            // (1) low leaf is a member of root_in (the circuit's first IMT check).
            assert_eq!(
                imt.tree.circuit_fold(&imt_leaf_hash(&env, &h, &low), &w.low_path),
                root_in,
                "low leaf must be in root_in for value {k}"
            );
            // (2) actually applying yields the witness's predicted root_out.
            let applied = imt.insert(v);
            assert_eq!(w.root_out, applied.root_out, "witness root_out must match apply for {k}");
            assert_eq!(imt.root(), applied.root_out);
            assert_ne!(imt.root(), root_in, "root must advance on insert of {k}");
        }
    }

    /// The root must advance on every insert (no two distinct leaf sets share a root here).
    #[test]
    fn root_advances_on_insert() {
        let env = env();
        let mut tree = NoteTree::new(&env);
        let empty = tree.root();
        let mut t = [0u8; 32];
        t[31] = 7;
        tree.ingest_shielded(1, 100, &t);
        let r1 = tree.root();
        assert_ne!(r1, empty);
        t[31] = 8;
        tree.ingest_shielded(1, 100, &t);
        assert_ne!(tree.root(), r1);
    }
}
