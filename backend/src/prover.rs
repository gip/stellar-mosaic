//! Low-level `bridge-prover` invocation: run the RISC Zero/Steel host to prove a Base deposit and
//! read back the seal/journal artifacts. Pure subprocess + filesystem work — no HTTP, no async, no
//! shared state — so it is easy to drive from a blocking task and to unit-test in isolation.

use crate::config::Config;
use serde::Serialize;
use std::path::Path;
use std::process::Command;

/// The proof artifacts the MCP worker needs to attest + mint. Byte-identical (as hex) to what the
/// old in-process worker persisted, so nothing downstream changes.
#[derive(Clone, Debug, Serialize)]
pub struct BaseDepositProof {
    pub seal_hex: String,
    pub journal_hex: String,
    pub block_number: i64,
    pub block_hash: String,
}

/// Parse the committed block from the 256-byte ABI journal: word 0 low 8 bytes = block number,
/// word 1 = block hash. Returns `(block_number, block_hash_hex)`.
pub fn parse_journal_block(journal: &[u8]) -> Option<(u64, String)> {
    if journal.len() != 256 {
        return None;
    }
    let mut n = [0u8; 8];
    n.copy_from_slice(&journal[24..32]);
    Some((u64::from_be_bytes(n), hex::encode(&journal[32..64])))
}

/// Run `cast <args> --rpc-url <rpc>` and parse the stdout as a u64 (e.g. a block number).
fn cast_number(cast: &str, rpc: &str, args: &[&str]) -> anyhow::Result<u64> {
    let mut a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    a.push("--rpc-url".into());
    a.push(rpc.to_string());
    let out = Command::new(cast).args(&a).output()?;
    anyhow::ensure!(
        out.status.success(),
        "cast {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr).trim()
    );
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    s.parse::<u64>()
        .map_err(|_| anyhow::anyhow!("cast returned non-numeric: {s}"))
}

/// Build the `run-host` command that proves `deposit_id` at `block`, writing artifacts to `out_dir`.
/// Kept byte-for-byte compatible with the launcher contract (`-- <host args>`, `RUST_LOG=info`).
pub fn prover_command(
    prover_dir: &Path,
    rpc: &str,
    bridge: &str,
    deposit_id: i64,
    block: u64,
    out_dir: &str,
) -> Command {
    let mut command = Command::new(prover_dir.join("run-host"));
    command
        .current_dir(prover_dir)
        .args([
            "--",
            "--rpc-url",
            rpc,
            "--bridge",
            bridge,
            "--deposit-id",
            &deposit_id.to_string(),
            "--block",
            &block.to_string(),
            "--prove",
            "--out-dir",
            out_dir,
        ])
        .env("RUST_LOG", "info");
    command
}

/// Read a completed proof from disk if both artifacts exist under `<prover_dir>/out/<job_id>/`.
/// This is the durable "done" signal: it survives a service restart, so a finished proof is never
/// re-run. Returns `None` if either artifact is missing or the journal is malformed.
pub fn read_proof_from_disk(config: &Config, job_id: &str) -> Option<BaseDepositProof> {
    let out = config.out_dir(job_id);
    let seal = std::fs::read(out.join("seal.bin")).ok()?;
    let journal = std::fs::read(out.join("journal.bin")).ok()?;
    let (block_number, block_hash) = parse_journal_block(&journal)?;
    Some(BaseDepositProof {
        seal_hex: hex::encode(seal),
        journal_hex: hex::encode(journal),
        block_number: block_number as i64,
        block_hash,
    })
}

/// Prove a Base deposit and return the artifacts (also left on disk under `out/<job_id>/`). Proves
/// at the current in-window head; the seal commits that block and never expires. Blocking: run it on
/// a blocking task. Idempotent — a completed proof on disk is returned without re-running.
pub fn run_prove(
    config: &Config,
    job_id: &str,
    bridge: &str,
    deposit_id: i64,
) -> anyhow::Result<BaseDepositProof> {
    if let Some(proof) = read_proof_from_disk(config, job_id) {
        return Ok(proof);
    }
    let rpc = config
        .base_rpc
        .clone()
        .ok_or_else(|| anyhow::anyhow!("base_rpc not configured"))?;
    let out_dir = config.out_dir(job_id);
    std::fs::create_dir_all(&out_dir)?;
    let out = out_dir.to_string_lossy().to_string();

    let head = cast_number(&config.cast_bin, &rpc, &["block-number"])?;
    let status = prover_command(&config.prover_dir, &rpc, bridge, deposit_id, head, &out).status()?;
    anyhow::ensure!(status.success(), "prover exited with {status}");

    read_proof_from_disk(config, job_id)
        .ok_or_else(|| anyhow::anyhow!("prover produced no readable seal/journal in {out}"))
}

#[cfg(test)]
mod tests {
    use super::{parse_journal_block, prover_command};
    use std::ffi::OsStr;
    use std::path::Path;

    #[test]
    fn parse_journal_block_reads_word0_and_word1() {
        let mut j = [0u8; 256];
        j[24..32].copy_from_slice(&0x1234u64.to_be_bytes()); // block number in word 0 low 8 bytes
        j[32..64].copy_from_slice(&[0xab; 32]); // block hash in word 1
        let (bn, bh) = parse_journal_block(&j).unwrap();
        assert_eq!(bn, 0x1234);
        assert_eq!(bh, "ab".repeat(32));
    }

    #[test]
    fn parse_journal_block_rejects_wrong_length() {
        assert!(parse_journal_block(&[0u8; 100]).is_none());
    }

    #[test]
    fn prover_command_uses_launcher_and_preserves_host_arguments() {
        let command = prover_command(
            Path::new("/tmp/bridge-prover"),
            "https://rpc.example",
            "0x1234",
            7,
            99,
            "/tmp/proof output",
        );

        assert_eq!(
            command.get_program(),
            OsStr::new("/tmp/bridge-prover/run-host")
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                "--",
                "--rpc-url",
                "https://rpc.example",
                "--bridge",
                "0x1234",
                "--deposit-id",
                "7",
                "--block",
                "99",
                "--prove",
                "--out-dir",
                "/tmp/proof output",
            ]
        );
        assert!(command
            .get_envs()
            .any(|(key, value)| key == "RUST_LOG" && value == Some(OsStr::new("info"))));
    }
}
