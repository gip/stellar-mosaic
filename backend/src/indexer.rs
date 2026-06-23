//! Off-chain note-tree reconstruction. Fetches the desk contract's `shielded`/`settled`/`noteins`
//! events via the `stellar events` CLI, replays them through `mosaic-indexer::NoteTree` (which uses
//! the contract's exact Poseidon2), and serves membership paths + the note set so a wallet can
//! build order/unshield proofs.
//!
//! Limitation: the RPC only retains a recent ledger window, so a desk older than that window cannot
//! be fully rebuilt. Fine for the demo (desks are used within the retention window).

use crate::error::{AppError, AppResult};
use crate::stellar::Stellar;
use base64::Engine;
use mosaic_indexer::{
    order_consumption_nullifier, u256_to_word, word_to_u256, Hasher, NoteTree, NullifierImt,
};
use serde::Serialize;
use soroban_sdk::{Env, U256};
use std::collections::HashSet;

/// A note-tree leaf-producing event, in insertion order (`shielded` / `noteins`). WS4 removed the
/// monolithic `settled` event; proceeds notes from `settle_match` and cancel returns are plain
/// `noteins`.
enum TreeEvent {
    Insert {
        asset: u32,
        amount: i128,
        tag: [u8; 32],
    },
}

/// One note known to the tree.
#[derive(Serialize, Clone)]
pub struct NoteInfo {
    pub leaf_index: usize,
    pub asset: u32,
    pub amount: String,
    pub owner_tag: String, // 0x + 64 hex
}

#[derive(Serialize)]
pub struct NoteProof {
    pub leaf_index: usize,
    pub root: String,          // 0x + 64 hex
    pub siblings: Vec<String>, // 32 entries, 0x + 64 hex
    pub index_bits: Vec<u8>,   // 32 entries (0/1)
}

/// Replay all events and return the full note list (for discovery).
pub fn notes(
    stellar: &Stellar,
    contract_id: &str,
    from_ledger: Option<u64>,
) -> AppResult<Vec<NoteInfo>> {
    let (_, notes) = build(stellar, contract_id, from_ledger)?;
    Ok(notes)
}

pub fn notes_from_raw(raw: &[serde_json::Value]) -> AppResult<Vec<NoteInfo>> {
    let (_, notes) = build_events(raw.iter().filter_map(parse_event).collect())?;
    Ok(notes)
}

/// One crossing fill, decoded from a `filled` event (emitted when a submitted order matches resting
/// liquidity). `owner_tag` is the taker's output destination; a client matches it against its own
/// order-output notes to show a "your order filled" confirmation with the exact traded amounts.
/// `in`/`out` are taker-perspective: `amount_in` of `asset_in` spent, `amount_out` of `asset_out`
/// received. Events are returned in emission order (oldest first).
#[derive(Serialize)]
pub struct FillInfo {
    pub id: String,
    pub ledger: u64,
    pub tx_hash: String,
    pub asset_in: u32,
    pub amount_in: String,
    pub asset_out: u32,
    pub amount_out: String,
    pub owner_tag: String, // 0x + 64 hex
}

pub fn fills_from_raw(raw: &[serde_json::Value]) -> Vec<FillInfo> {
    raw.iter().filter_map(parse_fill).collect()
}

/// Scan the contract's `filled` events (no tree replay needed — these are informational summaries).
pub fn fills(
    stellar: &Stellar,
    contract_id: &str,
    from_ledger: Option<u64>,
) -> AppResult<Vec<FillInfo>> {
    scan_events(stellar, contract_id, from_ledger, parse_fill)
}

/// Replay all events, find the leaf for `owner_tag` (0x hex), and return its membership path.
pub fn note_proof(
    stellar: &Stellar,
    contract_id: &str,
    from_ledger: Option<u64>,
    owner_tag: &str,
) -> AppResult<NoteProof> {
    let want = parse_hex32(owner_tag)?;
    let (tree, notes) = build(stellar, contract_id, from_ledger)?;
    let note = notes
        .iter()
        .find(|n| n.owner_tag == fmt_hex32(&want))
        .ok_or_else(|| AppError::NotFound(format!("no note with owner_tag {owner_tag}")))?;
    let path = tree.path(note.leaf_index);
    Ok(NoteProof {
        leaf_index: note.leaf_index,
        root: u256_hex(&tree.root()),
        siblings: path.siblings.iter().map(u256_hex).collect(),
        index_bits: path.index_bits.to_vec(),
    })
}

pub fn note_proof_from_raw(raw: &[serde_json::Value], owner_tag: &str) -> AppResult<NoteProof> {
    let want = parse_hex32(owner_tag)?;
    let (tree, notes) = build_events(raw.iter().filter_map(parse_event).collect())?;
    let note = notes
        .iter()
        .find(|n| n.owner_tag == fmt_hex32(&want))
        .ok_or_else(|| AppError::NotFound(format!("no note with owner_tag {owner_tag}")))?;
    let path = tree.path(note.leaf_index);
    Ok(NoteProof {
        leaf_index: note.leaf_index,
        root: u256_hex(&tree.root()),
        siblings: path.siblings.iter().map(u256_hex).collect(),
        index_bits: path.index_bits.to_vec(),
    })
}

/// Fetch + replay events into a NoteTree, recording the (leaf_index, note) list.
fn build(
    stellar: &Stellar,
    contract_id: &str,
    from_ledger: Option<u64>,
) -> AppResult<(NoteTree, Vec<NoteInfo>)> {
    let events = fetch_events(stellar, contract_id, from_ledger)?;
    build_events(events)
}

fn build_events(events: Vec<TreeEvent>) -> AppResult<(NoteTree, Vec<NoteInfo>)> {
    let env = Env::default();
    // The Env is only a hash engine here; lift its CPU budget so deep Poseidon folds don't trip it.
    env.cost_estimate().budget().reset_unlimited();
    let mut tree = NoteTree::new(&env);
    let mut notes = Vec::new();
    let mut record = |idx: usize, asset: u32, amount: i128, tag: &[u8; 32]| {
        notes.push(NoteInfo {
            leaf_index: idx,
            asset,
            amount: amount.to_string(),
            owner_tag: fmt_hex32(tag),
        });
    };
    for ev in events {
        match ev {
            TreeEvent::Insert { asset, amount, tag } => {
                let i = tree.ingest_note(asset, amount, &tag);
                record(i, asset, amount, &tag);
            }
        }
    }
    Ok((tree, notes))
}

/// Page through all of the contract's events from `from_ledger`, mapping each event line with
/// `parse` and collecting the `Some` results in emission order.
fn scan_events<T>(
    stellar: &Stellar,
    contract_id: &str,
    from_ledger: Option<u64>,
    parse: impl Fn(&serde_json::Value) -> Option<T>,
) -> AppResult<Vec<T>> {
    // Start near the desk's activity (stored at create) so a single scan window reaches its events;
    // fall back to the oldest retained ledger for imported desks.
    let oldest = match from_ledger {
        Some(l) => l,
        None => stellar.oldest_ledger(contract_id)?,
    };
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = if cursor.is_some() {
            stellar.events_page(contract_id, None, cursor.as_deref(), 10000)?
        } else {
            stellar.events_page(contract_id, Some(oldest), None, 10000)?
        };
        let mut last_id = None;
        let mut n = 0;
        for line in page.lines().filter(|l| !l.trim().is_empty()) {
            n += 1;
            let v: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                last_id = Some(id.to_string());
            }
            if let Some(t) = parse(&v) {
                out.push(t);
            }
        }
        if n < 10000 || last_id.is_none() {
            break;
        }
        cursor = last_id;
    }
    Ok(out)
}

/// Page through all of the contract's events and parse the tree-relevant ones, in order.
fn fetch_events(
    stellar: &Stellar,
    contract_id: &str,
    from_ledger: Option<u64>,
) -> AppResult<Vec<TreeEvent>> {
    scan_events(stellar, contract_id, from_ledger, parse_event)
}

fn parse_event(v: &serde_json::Value) -> Option<TreeEvent> {
    let topic_b64 = v.get("topic")?.as_array()?.first()?.as_str()?;
    let symbol = decode_symbol(topic_b64)?;
    let value_b64 = v.get("value")?.as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value_b64)
        .ok()?;
    let mut r = Rdr::new(&bytes);
    let n = r.vec_header()?;
    match symbol.as_str() {
        "shielded" | "noteins" if n == 3 => {
            let asset = r.scu32()?;
            let amount = r.sci128()?;
            let tag = r.scbytes32()?;
            Some(TreeEvent::Insert { asset, amount, tag })
        }
        _ => None,
    }
}

/// Parse a `filled` event into a `FillInfo` (taker-perspective trade summary). Returns `None` for
/// any other event. Value layout: `(u32 asset_in, i128 amount_in, u32 asset_out, i128 amount_out,
/// bytes32 output_owner_tag)`.
fn parse_fill(v: &serde_json::Value) -> Option<FillInfo> {
    let topic_b64 = v.get("topic")?.as_array()?.first()?.as_str()?;
    if decode_symbol(topic_b64)? != "filled" {
        return None;
    }
    let value_b64 = v.get("value")?.as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value_b64)
        .ok()?;
    let mut r = Rdr::new(&bytes);
    if r.vec_header()? != 5 {
        return None;
    }
    let asset_in = r.scu32()?;
    let amount_in = r.sci128()?;
    let asset_out = r.scu32()?;
    let amount_out = r.sci128()?;
    let tag = r.scbytes32()?;
    Some(FillInfo {
        id: v.get("id")?.as_str()?.to_string(),
        ledger: v.get("ledger").and_then(|x| x.as_u64()).unwrap_or(0),
        tx_hash: v
            .get("txHash")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        asset_in,
        amount_in: amount_in.to_string(),
        asset_out,
        amount_out: amount_out.to_string(),
        owner_tag: fmt_hex32(&tag),
    })
}

/// One resting order, decoded from an `orderins` event (full public terms + leaf). `active` is false
/// once the order's consumption nullifier `compress(ORDER_NULLIFIER_DOMAIN, order_leaf)` appears in a
/// `nfspent` event (matched or cancelled). This is the event-derived order book: no per-tx calldata
/// fetching, no contract `book()` call.
#[derive(Serialize, Clone)]
pub struct OrderInfo {
    pub leaf_index: usize,
    pub order_leaf: String, // 0x + 64 hex
    pub asset_in: u32,
    pub amount_in: String,
    pub asset_out: u32,
    pub min_out: String,
    pub output_owner_tag: String,
    pub cancel_owner_tag: String,
    pub expiry: u64,
    pub partial_allowed: bool,
    pub active: bool,
}

struct OrderRaw {
    asset_in: u32,
    amount_in: i128,
    asset_out: u32,
    min_out: i128,
    output_owner_tag: [u8; 32],
    cancel_owner_tag: [u8; 32],
    expiry: u64,
    partial_allowed: bool,
    order_leaf: [u8; 32],
}

/// Reconstruct the active order book purely from events: every `orderins` (placement or re-rested
/// match remainder) in tree-insert order, minus those whose consumption nullifier appears in
/// `nfspent`. `include_consumed` keeps the inactive ones (e.g. for history).
pub fn order_book(
    stellar: &Stellar,
    contract_id: &str,
    from_ledger: Option<u64>,
    include_consumed: bool,
) -> AppResult<Vec<OrderInfo>> {
    let orders = scan_events(stellar, contract_id, from_ledger, parse_orderins)?;
    let spent: Vec<[u8; 32]> = scan_events(stellar, contract_id, from_ledger, parse_nfspent)?;
    let spent: HashSet<[u8; 32]> = spent.into_iter().collect();
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let h = Hasher::new(&env);
    let mut out = Vec::new();
    for (i, o) in orders.iter().enumerate() {
        let leaf_u = word_to_u256(&env, &o.order_leaf);
        let nf = u256_to_word(&order_consumption_nullifier(&env, &h, &leaf_u));
        let active = !spent.contains(&nf);
        if active || include_consumed {
            out.push(OrderInfo {
                leaf_index: i,
                order_leaf: fmt_hex32(&o.order_leaf),
                asset_in: o.asset_in,
                amount_in: o.amount_in.to_string(),
                asset_out: o.asset_out,
                min_out: o.min_out.to_string(),
                output_owner_tag: fmt_hex32(&o.output_owner_tag),
                cancel_owner_tag: fmt_hex32(&o.cancel_owner_tag),
                expiry: o.expiry,
                partial_allowed: o.partial_allowed,
                active,
            });
        }
    }
    Ok(out)
}

/// Decode an `orderins` event: vec of [asset_in u32, amount_in i128, asset_out u32, min_out i128,
/// output_owner_tag bytes32, cancel_owner_tag bytes32, expiry u64, partial_allowed bool, order_leaf
/// bytes32]. Returns `None` for any other event.
fn parse_orderins(v: &serde_json::Value) -> Option<OrderRaw> {
    let topic_b64 = v.get("topic")?.as_array()?.first()?.as_str()?;
    if decode_symbol(topic_b64)? != "orderins" {
        return None;
    }
    let value_b64 = v.get("value")?.as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value_b64)
        .ok()?;
    let mut r = Rdr::new(&bytes);
    if r.vec_header()? != 9 {
        return None;
    }
    Some(OrderRaw {
        asset_in: r.scu32()?,
        amount_in: r.sci128()?,
        asset_out: r.scu32()?,
        min_out: r.sci128()?,
        output_owner_tag: r.scbytes32()?,
        cancel_owner_tag: r.scbytes32()?,
        expiry: r.scu64()?,
        partial_allowed: r.scbool()?,
        order_leaf: r.scbytes32()?,
    })
}

/// Decode a `nfspent` event: vec of [nullifier bytes32]. Returns `None` for any other event.
fn parse_nfspent(v: &serde_json::Value) -> Option<[u8; 32]> {
    let topic_b64 = v.get("topic")?.as_array()?.first()?.as_str()?;
    if decode_symbol(topic_b64)? != "nfspent" {
        return None;
    }
    let value_b64 = v.get("value")?.as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value_b64)
        .ok()?;
    let mut r = Rdr::new(&bytes);
    if r.vec_header()? != 1 {
        return None;
    }
    r.scbytes32()
}

/// Order-tree membership path for an `order_leaf` (0x hex), against the current order root. Lets a
/// matcher/canceller prove the order is a member of an accepted order root.
#[derive(Serialize)]
pub struct OrderProof {
    pub leaf_index: usize,
    pub order_root: String,
    pub siblings: Vec<String>,
    pub index_bits: Vec<u8>,
    /// compress(ORDER_NULLIFIER_DOMAIN, order_leaf) - the value a match/cancel consumes (so the
    /// client need not compute Poseidon to drive the imt-witness fetch + the proof's public input).
    pub consumption_nullifier: String,
}

fn order_proof_inner(orders: &[OrderRaw], order_leaf: &str) -> AppResult<OrderProof> {
    let want = parse_hex32(order_leaf)?;
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let h = Hasher::new(&env);
    let mut tree = NoteTree::new(&env);
    let mut found = None;
    for o in orders {
        let i = tree.insert_leaf(word_to_u256(&env, &o.order_leaf));
        if o.order_leaf == want {
            found = Some(i);
        }
    }
    let idx =
        found.ok_or_else(|| AppError::NotFound(format!("no order with leaf {order_leaf}")))?;
    let p = tree.path(idx);
    let nf = order_consumption_nullifier(&env, &h, &word_to_u256(&env, &want));
    Ok(OrderProof {
        leaf_index: idx,
        order_root: u256_hex(&tree.root()),
        siblings: p.siblings.iter().map(u256_hex).collect(),
        index_bits: p.index_bits.to_vec(),
        consumption_nullifier: u256_hex(&nf),
    })
}

pub fn order_proof_from_raw(raw: &[serde_json::Value], order_leaf: &str) -> AppResult<OrderProof> {
    let orders: Vec<OrderRaw> = raw.iter().filter_map(parse_orderins).collect();
    order_proof_inner(&orders, order_leaf)
}

pub fn order_proof(
    stellar: &Stellar,
    contract_id: &str,
    from_ledger: Option<u64>,
    order_leaf: &str,
) -> AppResult<OrderProof> {
    let orders = scan_events(stellar, contract_id, from_ledger, parse_orderins)?;
    order_proof_inner(&orders, order_leaf)
}

/// The nullifier-IMT insert witness for `value` (0x hex), against the CURRENT accumulator (all
/// `nfspent` replayed). This is exactly the imt_insert witness a spend circuit needs; the actual
/// insert lands when the spend's own `nfspent` is later observed.
#[derive(Serialize)]
pub struct ImtWitnessOut {
    pub nullifier_root_in: String,
    pub nullifier_root_out: String,
    pub low_value: String,
    pub low_next_value: String,
    pub low_next_index: u64,
    pub low_path: Vec<String>,
    pub low_index_bits: Vec<u8>,
    pub new_path: Vec<String>,
    pub new_index_bits: Vec<u8>,
}

fn imt_witness_inner(spent: &[[u8; 32]], value: &str) -> AppResult<ImtWitnessOut> {
    let v = parse_hex32(value)?;
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let mut imt = NullifierImt::new(&env);
    for nf in spent {
        imt.insert(word_to_u256(&env, nf));
    }
    let root_in = imt.root();
    let w = imt.witness(word_to_u256(&env, &v));
    Ok(ImtWitnessOut {
        nullifier_root_in: u256_hex(&root_in),
        nullifier_root_out: u256_hex(&w.root_out),
        low_value: u256_hex(&w.low_value),
        low_next_value: u256_hex(&w.low_next_value),
        low_next_index: w.low_next_index,
        low_path: w.low_path.siblings.iter().map(u256_hex).collect(),
        low_index_bits: w.low_path.index_bits.to_vec(),
        new_path: w.new_path.siblings.iter().map(u256_hex).collect(),
        new_index_bits: w.new_path.index_bits.to_vec(),
    })
}

pub fn imt_witness_from_raw(raw: &[serde_json::Value], value: &str) -> AppResult<ImtWitnessOut> {
    let spent: Vec<[u8; 32]> = raw.iter().filter_map(parse_nfspent).collect();
    imt_witness_inner(&spent, value)
}

/// Witnesses for inserting SEVERAL values in sequence, each against the root after the previous one
/// was inserted. This is what a multi-insert spend (join: 2; match: <=4) needs - the later inserts
/// fold against intermediate roots, not the current one.
fn imt_witnesses_inner(spent: &[[u8; 32]], values: &[String]) -> AppResult<Vec<ImtWitnessOut>> {
    let parsed: Result<Vec<[u8; 32]>, _> = values.iter().map(|v| parse_hex32(v)).collect();
    let parsed = parsed?;
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let mut imt = NullifierImt::new(&env);
    for nf in spent {
        imt.insert(word_to_u256(&env, nf));
    }
    let mut out = Vec::with_capacity(parsed.len());
    for v in &parsed {
        let vu = word_to_u256(&env, v);
        let root_in = imt.root();
        let w = imt.witness(vu.clone());
        out.push(ImtWitnessOut {
            nullifier_root_in: u256_hex(&root_in),
            nullifier_root_out: u256_hex(&w.root_out),
            low_value: u256_hex(&w.low_value),
            low_next_value: u256_hex(&w.low_next_value),
            low_next_index: w.low_next_index,
            low_path: w.low_path.siblings.iter().map(u256_hex).collect(),
            low_index_bits: w.low_path.index_bits.to_vec(),
            new_path: w.new_path.siblings.iter().map(u256_hex).collect(),
            new_index_bits: w.new_path.index_bits.to_vec(),
        });
        imt.insert(vu); // advance so the next value witnesses against the new root
    }
    Ok(out)
}

pub fn imt_witnesses_from_raw(
    raw: &[serde_json::Value],
    values: &[String],
) -> AppResult<Vec<ImtWitnessOut>> {
    let spent: Vec<[u8; 32]> = raw.iter().filter_map(parse_nfspent).collect();
    imt_witnesses_inner(&spent, values)
}

pub fn imt_witnesses(
    stellar: &Stellar,
    contract_id: &str,
    from_ledger: Option<u64>,
    values: &[String],
) -> AppResult<Vec<ImtWitnessOut>> {
    let spent = scan_events(stellar, contract_id, from_ledger, parse_nfspent)?;
    imt_witnesses_inner(&spent, values)
}

pub fn imt_witness(
    stellar: &Stellar,
    contract_id: &str,
    from_ledger: Option<u64>,
    value: &str,
) -> AppResult<ImtWitnessOut> {
    let spent = scan_events(stellar, contract_id, from_ledger, parse_nfspent)?;
    imt_witness_inner(&spent, value)
}

/// Decode a base64 ScVal::Symbol into its string.
fn decode_symbol(b64: &str) -> Option<String> {
    let b = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let mut r = Rdr::new(&b);
    let disc = r.u32()?;
    if disc != 15 {
        return None; // SCV_SYMBOL
    }
    let len = r.u32()? as usize;
    let s = r.take(len)?;
    String::from_utf8(s.to_vec()).ok()
}

// --- minimal XDR ScVal reader (big-endian, 4-byte aligned) ---
struct Rdr<'a> {
    b: &'a [u8],
    pos: usize,
}
impl<'a> Rdr<'a> {
    fn new(b: &'a [u8]) -> Self {
        Rdr { b, pos: 0 }
    }
    fn u32(&mut self) -> Option<u32> {
        let s = self.b.get(self.pos..self.pos + 4)?;
        self.pos += 4;
        Some(u32::from_be_bytes(s.try_into().ok()?))
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let pad = (4 - (n % 4)) % 4;
        let s = self.b.get(self.pos..self.pos + n)?;
        self.pos += n + pad;
        Some(s)
    }
    /// SCV_VEC discriminant (16) + present flag (1) + length. Returns the length.
    fn vec_header(&mut self) -> Option<usize> {
        if self.u32()? != 16 {
            return None;
        }
        if self.u32()? != 1 {
            return None;
        }
        Some(self.u32()? as usize)
    }
    fn scu32(&mut self) -> Option<u32> {
        if self.u32()? != 3 {
            return None;
        }
        self.u32()
    }
    fn sci128(&mut self) -> Option<i128> {
        if self.u32()? != 10 {
            return None;
        }
        let s = self.take(16)?;
        Some(i128::from_be_bytes(s.try_into().ok()?))
    }
    fn scu64(&mut self) -> Option<u64> {
        if self.u32()? != 5 {
            return None; // SCV_U64
        }
        let s = self.b.get(self.pos..self.pos + 8)?;
        self.pos += 8;
        Some(u64::from_be_bytes(s.try_into().ok()?))
    }
    fn scbool(&mut self) -> Option<bool> {
        if self.u32()? != 0 {
            return None; // SCV_BOOL
        }
        Some(self.u32()? != 0) // XDR bool is a 4-byte int
    }
    fn scbytes32(&mut self) -> Option<[u8; 32]> {
        if self.u32()? != 13 {
            return None;
        }
        let len = self.u32()? as usize;
        let s = self.take(len)?;
        let mut out = [0u8; 32];
        let off = 32usize.saturating_sub(len);
        out[off..].copy_from_slice(&s[..len.min(32)]);
        Some(out)
    }
}

// --- hex helpers ---
fn parse_hex32(s: &str) -> AppResult<[u8; 32]> {
    let h = s.strip_prefix("0x").unwrap_or(s);
    let h = format!("{:0>64}", h);
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&h[i * 2..i * 2 + 2], 16)
            .map_err(|_| AppError::BadRequest(format!("bad hex: {s}")))?;
    }
    Ok(out)
}
fn fmt_hex32(b: &[u8; 32]) -> String {
    let mut s = String::with_capacity(66);
    s.push_str("0x");
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}
fn u256_hex(u: &U256) -> String {
    let bytes = u.to_be_bytes();
    let mut out = [0u8; 32];
    let len = bytes.len() as usize;
    let off = 32usize.saturating_sub(len);
    for (i, x) in bytes.iter().enumerate() {
        if off + i < 32 {
            out[off + i] = x;
        }
    }
    fmt_hex32(&out)
}
