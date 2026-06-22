//! Server-driven Base->Stellar shield worker (WS6).
//!
//! Automates the validated manual flow (`scripts/10_demo_base_shield_testnet.sh`) as a durable,
//! crash-resumable background loop. Each `base_shields` job is advanced one step per tick, with all
//! progress (proof + committed block) persisted in SQL so a restart resumes where it left off:
//!
//!   proving           -> shell `bridge-prover` to prove the deposit at a recent (in-window) Base
//!                        block; store seal/journal + the committed (blockNumber, blockHash).
//!   awaiting_finality -> poll Base `finalized` (a pure block-number check, no eth_getProof) until
//!                        it reaches the proven block. This is the prove-then-finalize design:
//!                        prove while in the getProof window, mint only after finality.
//!   minting           -> attest the block hash + submit `shield_from_base` via the desk sponsor.
//!   active | failed   -> terminal.
//!
//! Disabled unless `MOSAIC_BASE_RPC` is set. Proving runs server-side (Steel/Groth16 cannot run in a
//! browser) and shells out to `cargo run -p host -- --prove`; finality uses `cast`.

use crate::db::BaseShieldJob;
use crate::error::{AppError, AppResult};
use crate::AppState;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

pub async fn run(state: Arc<AppState>) {
    tracing::info!("base-shield worker started");
    loop {
        if let Err(error) = tick(&state).await {
            tracing::warn!(%error, "base-shield worker tick failed");
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn tick(state: &Arc<AppState>) -> AppResult<()> {
    let Some(job) = state.db.next_base_shield().await? else {
        return Ok(());
    };
    match job.status.as_str() {
        "proving" => prove(state, &job).await,
        "awaiting_finality" => check_finality(state, &job).await,
        "minting" => mint(state, &job).await,
        _ => Ok(()),
    }
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

async fn prove(state: &Arc<AppState>, job: &BaseShieldJob) -> AppResult<()> {
    let rpc = state
        .config
        .base_rpc
        .clone()
        .ok_or_else(|| AppError::BadRequest("base_rpc not configured".into()))?;
    let cast = state.config.cast_bin.clone();
    let prover_dir = state.config.prover_dir.clone();
    let out_dir = prover_dir.join("out").join(&job.id);
    let bridge = job.bridge.clone();
    let deposit_id = job.deposit_id;
    let job_id = job.id.clone();

    // Prove against a recent (in-window) block; the seal commits that block and never expires.
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<(i64, String, String, String)> {
        let head = cast_number(&cast, &rpc, &["block-number"])?;
        let out = out_dir.to_string_lossy().to_string();
        let status = Command::new("cargo")
            .current_dir(&prover_dir)
            .args([
                "run", "--release", "-p", "host", "--",
                "--rpc-url", &rpc,
                "--bridge", &bridge,
                "--deposit-id", &deposit_id.to_string(),
                "--block", &head.to_string(),
                "--prove", "--out-dir", &out,
            ])
            .env("RUST_LOG", "info")
            .status()?;
        anyhow::ensure!(status.success(), "prover exited with {status}");
        let seal = std::fs::read(out_dir.join("seal.bin"))?;
        let journal = std::fs::read(out_dir.join("journal.bin"))?;
        let (bn, bh) =
            parse_journal_block(&journal).ok_or_else(|| anyhow::anyhow!("journal not 256 bytes"))?;
        Ok((bn as i64, bh, hex::encode(&seal), hex::encode(&journal)))
    })
    .await
    .map_err(|e| AppError::Other(e.into()))?;

    match result {
        Ok((bn, bh, seal_hex, journal_hex)) => {
            tracing::info!(job = %job_id, block = bn, "base-shield: proved; awaiting finality");
            state
                .db
                .base_shield_proved(&job_id, bn, &bh, &seal_hex, &journal_hex)
                .await?;
        }
        Err(e) => {
            tracing::warn!(job = %job_id, error = %e, "base-shield: prove failed");
            state.db.base_shield_failed(&job_id, &format!("prove: {e}")).await?;
        }
    }
    Ok(())
}

async fn check_finality(state: &Arc<AppState>, job: &BaseShieldJob) -> AppResult<()> {
    let target = job.block_number.unwrap_or(0);
    let rpc = state
        .config
        .base_rpc
        .clone()
        .ok_or_else(|| AppError::BadRequest("base_rpc not configured".into()))?;
    let cast = state.config.cast_bin.clone();
    let finalized = tokio::task::spawn_blocking(move || {
        cast_number(&cast, &rpc, &["block", "finalized", "--field", "number"])
    })
    .await
    .map_err(|e| AppError::Other(e.into()))?
    .map_err(AppError::Other)?;
    if finalized as i64 >= target {
        tracing::info!(job = %job.id, block = target, "base-shield: finalized; minting");
        state.db.base_shield_status(&job.id, "minting").await?;
    }
    Ok(())
}

async fn mint(state: &Arc<AppState>, job: &BaseShieldJob) -> AppResult<()> {
    let desk = state.db.get_desk(&job.desk_id).await?;
    let secret = state
        .db
        .sponsor_secret(&job.desk_id)
        .await?
        .ok_or_else(|| AppError::BadRequest("desk has no sponsor key (cannot mint)".into()))?;
    let block_number = job.block_number.unwrap_or(0) as u64;
    let block_hash = job.block_hash.clone().unwrap_or_default();
    let seal = hex::decode(job.seal_hex.clone().unwrap_or_default())
        .map_err(|e| AppError::Other(anyhow::anyhow!("bad seal hex: {e}")))?;
    let journal = hex::decode(job.journal_hex.clone().unwrap_or_default())
        .map_err(|e| AppError::Other(anyhow::anyhow!("bad journal hex: {e}")))?;
    let out_dir = state.config.prover_dir.join("out").join(&job.id);
    let stellar = state.stellar.clone();
    let cid = desk.contract_id.clone();
    let job_id = job.id.clone();

    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        std::fs::create_dir_all(&out_dir)?;
        let seal_path = out_dir.join("seal.bin");
        let journal_path = out_dir.join("journal.bin");
        std::fs::write(&seal_path, &seal)?;
        std::fs::write(&journal_path, &journal)?;
        stellar
            .attest_base_block(&cid, &secret, block_number, &block_hash)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        stellar
            .shield_from_base(&cid, &secret, &seal_path, &journal_path)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(e.into()))?;

    match result {
        Ok(()) => {
            tracing::info!(job = %job_id, "base-shield: minted (active)");
            state.db.base_shield_status(&job_id, "active").await?;
        }
        Err(e) => {
            tracing::warn!(job = %job_id, error = %e, "base-shield: mint failed");
            state.db.base_shield_failed(&job_id, &format!("mint: {e}")).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_journal_block;

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
}
