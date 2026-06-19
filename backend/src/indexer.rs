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
use mosaic_indexer::NoteTree;
use serde::Serialize;
use soroban_sdk::{Env, U256};

/// A leaf-producing event, in insertion order.
enum TreeEvent {
    Insert { asset: u32, amount: i128, tag: [u8; 32] },
    Settled([(u32, i128, [u8; 32]); 2]),
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
    pub root: String,                  // 0x + 64 hex
    pub siblings: Vec<String>,         // 32 entries, 0x + 64 hex
    pub index_bits: Vec<u8>,           // 32 entries (0/1)
}

/// Replay all events and return the full note list (for discovery).
pub fn notes(stellar: &Stellar, contract_id: &str, from_ledger: Option<u64>) -> AppResult<Vec<NoteInfo>> {
    let (_, notes) = build(stellar, contract_id, from_ledger)?;
    Ok(notes)
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

/// Fetch + replay events into a NoteTree, recording the (leaf_index, note) list.
fn build(
    stellar: &Stellar,
    contract_id: &str,
    from_ledger: Option<u64>,
) -> AppResult<(NoteTree, Vec<NoteInfo>)> {
    let events = fetch_events(stellar, contract_id, from_ledger)?;
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
            TreeEvent::Settled([(aao, bai, at), (bao, aai, bt)]) => {
                let (ia, ib) = tree.ingest_settled(aao, bai, &at, bao, aai, &bt);
                record(ia, aao, bai, &at);
                record(ib, bao, aai, &bt);
            }
        }
    }
    Ok((tree, notes))
}

/// Page through all of the contract's events and parse the tree-relevant ones, in order.
fn fetch_events(
    stellar: &Stellar,
    contract_id: &str,
    from_ledger: Option<u64>,
) -> AppResult<Vec<TreeEvent>> {
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
            if let Some(ev) = parse_event(&v) {
                out.push(ev);
            }
        }
        if n < 10000 || last_id.is_none() {
            break;
        }
        cursor = last_id;
    }
    Ok(out)
}

fn parse_event(v: &serde_json::Value) -> Option<TreeEvent> {
    let topic_b64 = v.get("topic")?.as_array()?.first()?.as_str()?;
    let symbol = decode_symbol(topic_b64)?;
    let value_b64 = v.get("value")?.as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(value_b64).ok()?;
    let mut r = Rdr::new(&bytes);
    let n = r.vec_header()?;
    match symbol.as_str() {
        "shielded" | "noteins" if n == 3 => {
            let asset = r.scu32()?;
            let amount = r.sci128()?;
            let tag = r.scbytes32()?;
            Some(TreeEvent::Insert { asset, amount, tag })
        }
        "settled" if n == 6 => {
            let aao = r.scu32()?;
            let bai = r.sci128()?;
            let at = r.scbytes32()?;
            let bao = r.scu32()?;
            let aai = r.sci128()?;
            let bt = r.scbytes32()?;
            Some(TreeEvent::Settled([(aao, bai, at), (bao, aai, bt)]))
        }
        _ => None,
    }
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
