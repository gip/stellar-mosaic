//! `witness` — a scriptable path server / Prover.toml helper for the Stellar Mosaic note tree.
//!
//! Reads a line-based event log on stdin, replays it into the note tree, and prints membership
//! witnesses for the leaves you ask about. This is what makes `tests/fixtures/regen.sh`
//! reproducible: instead of hand-choosing a Merkle path, you feed the real shield/settle history
//! and copy the printed `path` / `index_bits` into the circuit's `Prover.toml`.
//!
//! Tree / path commands (one per line; `#` comments and blank lines ignored):
//!
//!   shield  <asset:u32> <amount:i128> <owner_tag:hex32>
//!   settled <a_asset_out:u32> <b_amount_in:i128> <a_tag:hex32> \
//!           <b_asset_out:u32> <a_amount_in:i128> <b_tag:hex32>
//!   root                                  # prints `root = "0x.."` (Prover.toml line)
//!   path    <leaf_index:usize>            # prints leaf/root/path/index_bits (Prover.toml fragment)
//!
//! Wallet crypto-helper commands (compute the field values a Prover.toml needs; each prints one bare
//! `0x..` line so a script can capture it). `<field>` is decimal or `0x..` hex:
//!
//!   compress   <a> <b>                    # 2-to-1 Poseidon2 compression
//!   notetag    <sk> <rho>                 # owner_tag = compress(compress(sk,0), rho)
//!   nullifier  <sk> <rho>                 # nullifier = compress(sk, rho)
//!   orderleaf  <asset_in> <amount_in> <asset_out> <min_out> <out_tag> <cancel_tag>  # hash6
//!   recipient  <strkey>                   # sha256(address.xdr), top byte zeroed (unshield binding)
//!
//! `shield`/`settled` mirror the contract's events and insert leaves in the exact on-chain order.

use std::io::{BufRead, Write};

use mosaic_indexer::{u256_hex, word_to_u256, Hasher, NoteTree, TREE_DEPTH};
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

/// 6-input left-to-right fold (the circuits' `hash6`), used for the order leaf.
#[allow(clippy::too_many_arguments)]
fn hash6(env: &Env, h: &Hasher, a: &U256, b: &U256, c: &U256, d: &U256, e: &U256, f: &U256) -> U256 {
    let mut acc = h.compress(env, a, b);
    acc = h.compress(env, &acc, c);
    acc = h.compress(env, &acc, d);
    acc = h.compress(env, &acc, e);
    h.compress(env, &acc, f)
}

fn run() -> Result<(), String> {
    // A local Soroban host used purely as the Poseidon2 hashing engine (see lib.rs).
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let mut tree = NoteTree::new(&env);

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
                if tok.len() != 7 {
                    return Err(ctx(
                        "orderleaf needs: <asset_in> <amount_in> <asset_out> <min_out> <out_tag> <cancel_tag>".into(),
                    ));
                }
                let f: Result<Vec<U256>, String> =
                    tok[1..7].iter().map(|t| parse_field(&env, t)).collect();
                let f = f.map_err(&ctx)?;
                writeln!(
                    out,
                    "{}",
                    u256_hex(&hash6(&env, &h, &f[0], &f[1], &f[2], &f[3], &f[4], &f[5]))
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
