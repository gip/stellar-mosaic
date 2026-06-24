//! `witness` — a scriptable path server / Prover.toml helper for the Stellar Mosaic note tree.
//!
//! Reads a line-based event log on stdin, replays it into the note tree, and prints membership
//! witnesses for the leaves you ask about. This is what makes `tests/fixtures/regen.sh`
//! reproducible: instead of hand-choosing a Merkle path, you feed the real shield/settle history
//! and copy the printed `path` / `index_bits` into the circuit's `Prover.toml`.
//!
//! State is three structures mirroring the contract: the note tree, the order-commitment tree, and
//! the nullifier accumulator (IMT). Feed the real event history, then ask for the witnesses a proof
//! needs. Commands (one per line; `#` comments and blank lines ignored):
//!
//! Note tree (event replay + path):
//!   shield  <asset:u32> <amount:i128> <owner_tag:hex32>
//!   noteins <asset:u32> <amount:i128> <owner_tag:hex32>   # settle_match proceeds / cancel return
//!   settled <a_asset_out> <b_amount_in> <a_tag> <b_asset_out> <a_amount_in> <b_tag>   # legacy
//!   root                                  # `root = "0x.."`
//!   path    <leaf_index>                  # leaf/root/path/index_bits (Prover.toml fragment)
//!
//! Order tree (orderins event replay + path):
//!   orderins  <asset_in> <amount_in> <asset_out> <min_out> <out_tag> <cancel_tag> <expiry> <partial>
//!   orderroot                             # `order_root = "0x.."`
//!   orderpath <leaf_index>                # order_root/order_path/order_index_bits fragment
//!
//! Nullifier accumulator (IMT):
//!   nfspent    <value>                    # APPLY an insert (replay an observed consumption)
//!   imtroot                               # `nullifier_root = "0x.."`
//!   imtwitness <value>                    # NON-mutating: nullifier_root_in/out + low/new leaf+paths
//!                                         #   the imt_insert witness a spend circuit needs
//!
//! Wallet crypto helpers (each prints one bare `0x..` line; `<field>` is decimal or `0x..` hex):
//!   compress  <a> <b>                     # 2-to-1 Poseidon2 compression
//!   notetag   <sk> <rho>                  # legacy owner_tag = compress(compress(sk,0), rho)
//!   notetagn  <sk> <rho> <nonce>          # note tag = compress(compress(compress(sk,0),rho),nonce)
//!   nullifier <sk> <rho>                  # legacy nullifier = compress(sk, rho)
//!   notenull  <sk> <rho> <nonce>          # note-spend nullifier = compress(sk, compress(rho,nonce))
//!   ordernull <order_leaf>                # order-consumption nullifier = compress(7, order_leaf)
//!   orderleaf <asset_in> <amount_in> <asset_out> <min_out> <out_tag> <cancel_tag> <expiry> <partial>
//!   recipient <strkey>                    # sha256(address.xdr), top byte zeroed (unshield binding)

use std::io::{BufRead, Write};

use mosaic_indexer::{
    order_consumption_nullifier, order_leaf, u256_hex, word_to_u256, Hasher, NoteTree, NullifierImt,
    TREE_DEPTH,
};
use soroban_sdk::{xdr::ToXdr, Address, Env, String as SorobanString, U256};

fn parse_hex32(s: &str) -> Result<[u8; 32], String> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() != 64 {
        return Err(format!("expected 64 hex chars, got {}", s.len()));
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
            .map_err(|e| format!("bad hex byte: {e}"))?;
    }
    Ok(out)
}

/// Parse a field value: `0x..` hex (any length up to 64 digits, left-padded) or a decimal u128.
fn parse_field(env: &Env, s: &str) -> Result<U256, String> {
    if let Some(hex) = s.strip_prefix("0x") {
        if hex.is_empty() || hex.len() > 64 {
            return Err(format!("hex field must be 1..=64 digits, got {}", hex.len()));
        }
        let padded = format!("{:0>64}", hex);
        let w = parse_hex32(&padded)?;
        Ok(word_to_u256(env, &w))
    } else {
        let v: u128 = s.parse().map_err(|_| format!("bad decimal field '{s}'"))?;
        Ok(U256::from_u128(env, v))
    }
}

/// 8-input left-to-right fold (the circuits' `hash8`), used for the order leaf.
#[allow(clippy::too_many_arguments)]
fn hash8(
    env: &Env,
    h: &Hasher,
    a: &U256,
    b: &U256,
    c: &U256,
    d: &U256,
    e: &U256,
    f: &U256,
    g: &U256,
    i: &U256,
) -> U256 {
    let mut acc = h.compress(env, a, b);
    acc = h.compress(env, &acc, c);
    acc = h.compress(env, &acc, d);
    acc = h.compress(env, &acc, e);
    acc = h.compress(env, &acc, f);
    acc = h.compress(env, &acc, g);
    h.compress(env, &acc, i)
}

/// Print `name = ["0x..", ...]` (32 Field siblings) for a Prover.toml.
fn print_u256_array(
    out: &mut impl Write,
    name: &str,
    vals: &[U256; TREE_DEPTH],
) -> Result<(), String> {
    write!(out, "{name} = [").map_err(|e| e.to_string())?;
    for (i, v) in vals.iter().enumerate() {
        if i > 0 {
            write!(out, ", ").map_err(|e| e.to_string())?;
        }
        write!(out, "\"{}\"", u256_hex(v)).map_err(|e| e.to_string())?;
    }
    writeln!(out, "]").map_err(|e| e.to_string())
}

/// Print `name = ["0", "1", ...]` (32 boolean index bits) for a Prover.toml.
fn print_bits_array(
    out: &mut impl Write,
    name: &str,
    bits: &[u8; TREE_DEPTH],
) -> Result<(), String> {
    write!(out, "{name} = [").map_err(|e| e.to_string())?;
    for (i, b) in bits.iter().enumerate() {
        if i > 0 {
            write!(out, ", ").map_err(|e| e.to_string())?;
        }
        write!(out, "\"{b}\"").map_err(|e| e.to_string())?;
    }
    writeln!(out, "]").map_err(|e| e.to_string())
}

fn run() -> Result<(), String> {
    // A local Soroban host used purely as the Poseidon2 hashing engine (see lib.rs).
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let mut tree = NoteTree::new(&env); // note-commitment tree
    let mut order_tree = NoteTree::new(&env); // order-commitment tree
    let mut nf_imt = NullifierImt::new(&env); // nullifier accumulator (IMT)

    let h = Hasher::new(&env);

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    for (lineno, line) in stdin.lock().lines().enumerate() {
        let line = line.map_err(|e| e.to_string())?;
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let tok: Vec<&str> = line.split_whitespace().collect();
        let ctx = |e: String| format!("line {}: {e}", lineno + 1);
        match tok[0] {
            "shield" => {
                if tok.len() != 4 {
                    return Err(ctx("shield needs: <asset> <amount> <owner_tag>".into()));
                }
                let asset: u32 = tok[1].parse().map_err(|_| ctx("bad asset".into()))?;
                let amount: i128 = tok[2].parse().map_err(|_| ctx("bad amount".into()))?;
                let tag = parse_hex32(tok[3]).map_err(ctx)?;
                let idx = tree.ingest_shielded(asset, amount, &tag);
                writeln!(out, "# shield -> leaf index {idx}").map_err(|e| e.to_string())?;
            }
            "settled" => {
                if tok.len() != 7 {
                    return Err(ctx(
                        "settled needs: <a_asset_out> <b_amount_in> <a_tag> <b_asset_out> <a_amount_in> <b_tag>".into(),
                    ));
                }
                let a_asset_out: u32 = tok[1].parse().map_err(|_| ctx("bad a_asset_out".into()))?;
                let b_amount_in: i128 = tok[2].parse().map_err(|_| ctx("bad b_amount_in".into()))?;
                let a_tag = parse_hex32(tok[3]).map_err(ctx)?;
                let b_asset_out: u32 = tok[4].parse().map_err(|_| ctx("bad b_asset_out".into()))?;
                let a_amount_in: i128 = tok[5].parse().map_err(|_| ctx("bad a_amount_in".into()))?;
                let b_tag = parse_hex32(tok[6]).map_err(ctx)?;
                let (ia, ib) = tree.ingest_settled(
                    a_asset_out,
                    b_amount_in,
                    &a_tag,
                    b_asset_out,
                    a_amount_in,
                    &b_tag,
                );
                writeln!(out, "# settled -> leaf indices {ia}, {ib}").map_err(|e| e.to_string())?;
            }
            "root" => {
                writeln!(out, "root = \"{}\"", u256_hex(&tree.root())).map_err(|e| e.to_string())?;
            }
            "path" => {
                if tok.len() != 2 {
                    return Err(ctx("path needs: <leaf_index>".into()));
                }
                let index: usize = tok[1].parse().map_err(|_| ctx("bad index".into()))?;
                if index >= tree.len() {
                    return Err(ctx(format!(
                        "leaf index {index} out of range (tree has {} leaves)",
                        tree.len()
                    )));
                }
                let leaf = tree.leaf(index).expect("checked in range");
                let p = tree.path(index);
                // Sanity: the witness must fold to the current root, else it won't satisfy the
                // circuit. We refuse to print a path that doesn't.
                let folded = tree.circuit_fold(&leaf, &p);
                if folded != tree.root() {
                    return Err(ctx(format!(
                        "internal error: path for leaf {index} does not fold to the root"
                    )));
                }
                writeln!(out, "# --- Prover.toml witness for leaf index {index} ---")
                    .map_err(|e| e.to_string())?;
                writeln!(out, "# leaf = {}", u256_hex(&leaf)).map_err(|e| e.to_string())?;
                writeln!(out, "root = \"{}\"", u256_hex(&tree.root())).map_err(|e| e.to_string())?;
                // path = [...] and index_bits = [...] as the circuit expects (LSB-first).
                write!(out, "path = [").map_err(|e| e.to_string())?;
                for (i, sib) in p.siblings.iter().enumerate() {
                    if i > 0 {
                        write!(out, ", ").map_err(|e| e.to_string())?;
                    }
                    write!(out, "\"{}\"", u256_hex(sib)).map_err(|e| e.to_string())?;
                }
                writeln!(out, "]").map_err(|e| e.to_string())?;
                write!(out, "index_bits = [").map_err(|e| e.to_string())?;
                for i in 0..TREE_DEPTH {
                    if i > 0 {
                        write!(out, ", ").map_err(|e| e.to_string())?;
                    }
                    write!(out, "\"{}\"", p.index_bits[i]).map_err(|e| e.to_string())?;
                }
                writeln!(out, "]").map_err(|e| e.to_string())?;
            }
            "compress" => {
                if tok.len() != 3 {
                    return Err(ctx("compress needs: <a> <b>".into()));
                }
                let a = parse_field(&env, tok[1]).map_err(&ctx)?;
                let b = parse_field(&env, tok[2]).map_err(&ctx)?;
                writeln!(out, "{}", u256_hex(&h.compress(&env, &a, &b)))
                    .map_err(|e| e.to_string())?;
            }
            "notetag" => {
                if tok.len() != 3 {
                    return Err(ctx("notetag needs: <sk> <rho>".into()));
                }
                let sk = parse_field(&env, tok[1]).map_err(&ctx)?;
                let rho = parse_field(&env, tok[2]).map_err(&ctx)?;
                let zero = U256::from_u32(&env, 0);
                let pk = h.compress(&env, &sk, &zero);
                writeln!(out, "{}", u256_hex(&h.compress(&env, &pk, &rho)))
                    .map_err(|e| e.to_string())?;
            }
            "nullifier" => {
                if tok.len() != 3 {
                    return Err(ctx("nullifier needs: <sk> <rho>".into()));
                }
                let sk = parse_field(&env, tok[1]).map_err(&ctx)?;
                let rho = parse_field(&env, tok[2]).map_err(&ctx)?;
                writeln!(out, "{}", u256_hex(&h.compress(&env, &sk, &rho)))
                    .map_err(|e| e.to_string())?;
            }
            "orderleaf" => {
                if tok.len() != 9 {
                    return Err(ctx(
                        "orderleaf needs: <asset_in> <amount_in> <asset_out> <min_out> <out_tag> <cancel_tag> <expiry> <partial_allowed>".into(),
                    ));
                }
                let f: Result<Vec<U256>, String> =
                    tok[1..9].iter().map(|t| parse_field(&env, t)).collect();
                let f = f.map_err(&ctx)?;
                writeln!(
                    out,
                    "{}",
                    u256_hex(&hash8(
                        &env, &h, &f[0], &f[1], &f[2], &f[3], &f[4], &f[5], &f[6], &f[7]
                    ))
                )
                .map_err(|e| e.to_string())?;
            }
            "recipient" => {
                if tok.len() != 2 {
                    return Err(ctx("recipient needs: <strkey>".into()));
                }
                let addr = Address::from_string(&SorobanString::from_str(&env, tok[1]));
                let hash = env.crypto().sha256(&addr.to_xdr(&env)).to_array();
                let mut w = [0u8; 32];
                w[1..32].copy_from_slice(&hash[1..32]); // zero the top byte -> field < 2^248
                writeln!(out, "{}", u256_hex(&word_to_u256(&env, &w))).map_err(|e| e.to_string())?;
            }
            "noteins" => {
                // note-tree insert: a settle_match proceeds note or a cancel return.
                if tok.len() != 4 {
                    return Err(ctx("noteins needs: <asset> <amount> <owner_tag>".into()));
                }
                let asset: u32 = tok[1].parse().map_err(|_| ctx("bad asset".into()))?;
                let amount: i128 = tok[2].parse().map_err(|_| ctx("bad amount".into()))?;
                let tag = parse_hex32(tok[3]).map_err(ctx)?;
                let idx = tree.ingest_note(asset, amount, &tag);
                writeln!(out, "# noteins -> leaf index {idx}").map_err(|e| e.to_string())?;
            }
            "orderins" => {
                // order-tree insert: compute the leaf (= H8 of terms) and append it.
                if tok.len() != 9 {
                    return Err(ctx("orderins needs: <asset_in> <amount_in> <asset_out> <min_out> <out_tag> <cancel_tag> <expiry> <partial>".into()));
                }
                let asset_in: u32 = tok[1].parse().map_err(|_| ctx("bad asset_in".into()))?;
                let amount_in: i128 = tok[2].parse().map_err(|_| ctx("bad amount_in".into()))?;
                let asset_out: u32 = tok[3].parse().map_err(|_| ctx("bad asset_out".into()))?;
                let min_out: i128 = tok[4].parse().map_err(|_| ctx("bad min_out".into()))?;
                let out_tag = parse_hex32(tok[5]).map_err(ctx)?;
                let cancel_tag = parse_hex32(tok[6]).map_err(ctx)?;
                let expiry: u64 = tok[7].parse().map_err(|_| ctx("bad expiry".into()))?;
                let partial = match tok[8] {
                    "0" => false,
                    "1" => true,
                    _ => return Err(ctx("partial must be 0/1".into())),
                };
                let leaf = order_leaf(
                    &env, &h, asset_in, amount_in, asset_out, min_out, &out_tag, &cancel_tag,
                    expiry, partial,
                );
                let idx = order_tree.insert_leaf(leaf.clone());
                writeln!(out, "# orderins -> leaf {} at index {idx}", u256_hex(&leaf))
                    .map_err(|e| e.to_string())?;
            }
            "nfspent" => {
                // apply an IMT insert for a consumed nullifier value (advances the accumulator).
                if tok.len() != 2 {
                    return Err(ctx("nfspent needs: <value>".into()));
                }
                let v = parse_field(&env, tok[1]).map_err(&ctx)?;
                let w = nf_imt.insert(v);
                writeln!(out, "# nfspent -> imt root {}", u256_hex(&w.root_out))
                    .map_err(|e| e.to_string())?;
            }
            "orderroot" => {
                writeln!(out, "order_root = \"{}\"", u256_hex(&order_tree.root()))
                    .map_err(|e| e.to_string())?;
            }
            "imtroot" => {
                writeln!(out, "nullifier_root = \"{}\"", u256_hex(&nf_imt.root()))
                    .map_err(|e| e.to_string())?;
            }
            "orderpath" => {
                if tok.len() != 2 {
                    return Err(ctx("orderpath needs: <leaf_index>".into()));
                }
                let index: usize = tok[1].parse().map_err(|_| ctx("bad index".into()))?;
                if index >= order_tree.len() {
                    return Err(ctx(format!(
                        "order leaf index {index} out of range (tree has {} leaves)",
                        order_tree.len()
                    )));
                }
                let leaf = order_tree.leaf(index).expect("checked in range");
                let p = order_tree.path(index);
                if order_tree.circuit_fold(&leaf, &p) != order_tree.root() {
                    return Err(ctx(format!(
                        "internal error: order path for leaf {index} does not fold to the root"
                    )));
                }
                writeln!(out, "# --- order-tree witness for leaf index {index} ---")
                    .map_err(|e| e.to_string())?;
                writeln!(out, "# order_leaf = {}", u256_hex(&leaf)).map_err(|e| e.to_string())?;
                writeln!(out, "order_root = \"{}\"", u256_hex(&order_tree.root()))
                    .map_err(|e| e.to_string())?;
                print_u256_array(&mut out, "order_path", &p.siblings)?;
                print_bits_array(&mut out, "order_index_bits", &p.index_bits)?;
            }
            "imtwitness" => {
                // NON-mutating: the witnesses a spend's imt_insert needs to consume <value> against
                // the CURRENT accumulator root. The real insert lands when its nfspent is observed.
                if tok.len() != 2 {
                    return Err(ctx("imtwitness needs: <value>".into()));
                }
                let v = parse_field(&env, tok[1]).map_err(&ctx)?;
                let root_in = nf_imt.root();
                let w = nf_imt.witness(v);
                writeln!(out, "# --- IMT insert witness ---").map_err(|e| e.to_string())?;
                writeln!(out, "nullifier_root_in = \"{}\"", u256_hex(&root_in))
                    .map_err(|e| e.to_string())?;
                writeln!(out, "nullifier_root_out = \"{}\"", u256_hex(&w.root_out))
                    .map_err(|e| e.to_string())?;
                writeln!(out, "low_value = \"{}\"", u256_hex(&w.low_value))
                    .map_err(|e| e.to_string())?;
                writeln!(out, "low_next_value = \"{}\"", u256_hex(&w.low_next_value))
                    .map_err(|e| e.to_string())?;
                writeln!(out, "low_next_index = \"{}\"", w.low_next_index)
                    .map_err(|e| e.to_string())?;
                print_u256_array(&mut out, "low_path", &w.low_path.siblings)?;
                print_bits_array(&mut out, "low_index_bits", &w.low_path.index_bits)?;
                print_u256_array(&mut out, "new_path", &w.new_path.siblings)?;
                print_bits_array(&mut out, "new_index_bits", &w.new_path.index_bits)?;
                writeln!(out, "pred_leaf = \"{}\"", u256_hex(&w.pred_leaf))
                    .map_err(|e| e.to_string())?;
                print_u256_array(&mut out, "pred_path", &w.pred_path.siblings)?;
                print_bits_array(&mut out, "pred_index_bits", &w.pred_path.index_bits)?;
            }
            "ordernull" => {
                // order-consumption nullifier = compress(ORDER_NULLIFIER_DOMAIN, order_leaf).
                if tok.len() != 2 {
                    return Err(ctx("ordernull needs: <order_leaf>".into()));
                }
                let leaf = parse_field(&env, tok[1]).map_err(&ctx)?;
                writeln!(out, "{}", u256_hex(&order_consumption_nullifier(&env, &h, &leaf)))
                    .map_err(|e| e.to_string())?;
            }
            "notenull" => {
                // nonce-aware note-spend nullifier = compress(sk, compress(rho, nonce)).
                if tok.len() != 4 {
                    return Err(ctx("notenull needs: <sk> <rho> <nonce>".into()));
                }
                let sk = parse_field(&env, tok[1]).map_err(&ctx)?;
                let rho = parse_field(&env, tok[2]).map_err(&ctx)?;
                let nonce = parse_field(&env, tok[3]).map_err(&ctx)?;
                let inner = h.compress(&env, &rho, &nonce);
                writeln!(out, "{}", u256_hex(&h.compress(&env, &sk, &inner)))
                    .map_err(|e| e.to_string())?;
            }
            "notetagn" => {
                // nonce-aware note owner tag = compress(compress(compress(sk,0),rho),nonce).
                if tok.len() != 4 {
                    return Err(ctx("notetagn needs: <sk> <rho> <nonce>".into()));
                }
                let sk = parse_field(&env, tok[1]).map_err(&ctx)?;
                let rho = parse_field(&env, tok[2]).map_err(&ctx)?;
                let nonce = parse_field(&env, tok[3]).map_err(&ctx)?;
                let zero = U256::from_u32(&env, 0);
                let pk = h.compress(&env, &sk, &zero);
                let base = h.compress(&env, &pk, &rho);
                writeln!(out, "{}", u256_hex(&h.compress(&env, &base, &nonce)))
                    .map_err(|e| e.to_string())?;
            }
            other => return Err(ctx(format!("unknown command '{other}'"))),
        }
    }
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("witness: {e}");
        std::process::exit(1);
    }
}
