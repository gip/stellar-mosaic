//! Async prove manager: turns the blocking `bridge-prover` run into a submit/poll job so the MCP
//! worker never holds a ~10-minute HTTP connection open.
//!
//! - `submit` is idempotent by `job_id`: a completed proof on disk, or an already-running task, is a
//!   no-op; otherwise it spawns the prover in the background and returns immediately.
//! - `status` reports `Done` (read from disk), `Running`/`Error` (in-memory), or `NotStarted`.
//! - Proving is serialized by a permit semaphore of 1 (a single deposit proof already saturates the
//!   machine); extra submissions queue behind the permit and show as `Running` meanwhile.
//!
//! Durability model: the on-disk artifacts under `<prover_dir>/out/<job_id>/` are the source of
//! truth for "done", so a completed proof survives a restart. In-flight/error state is in-memory
//! only — after a crash an incomplete job reports `NotStarted` and the MCP worker simply resubmits
//! (a fresh, idempotent re-prove at a new in-window head).

use crate::config::Config;
use crate::prover::{read_proof_from_disk, run_prove, BaseDepositProof};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;

#[derive(Clone)]
enum JobState {
    Running,
    Error(String),
}

/// What a poll returns to the HTTP layer.
pub enum ProveStatus {
    Running,
    Done(BaseDepositProof),
    Error(String),
    NotStarted,
}

pub struct ProveManager {
    config: Config,
    permits: Arc<Semaphore>,
    jobs: Arc<Mutex<HashMap<String, JobState>>>,
}

impl ProveManager {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            permits: Arc::new(Semaphore::new(1)),
            jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Idempotently ensure a proof for `job_id` is being produced. Returns the current status.
    pub fn submit(&self, job_id: String, bridge: String, deposit_id: i64) -> ProveStatus {
        if let Some(proof) = read_proof_from_disk(&self.config, &job_id) {
            return ProveStatus::Done(proof);
        }
        {
            let mut jobs = self.jobs.lock().unwrap();
            if matches!(jobs.get(&job_id), Some(JobState::Running)) {
                return ProveStatus::Running;
            }
            // A prior Error is retryable: fall through and start a fresh run.
            jobs.insert(job_id.clone(), JobState::Running);
        }

        let config = self.config.clone();
        let permits = self.permits.clone();
        let jobs = self.jobs.clone();
        tokio::spawn(async move {
            // Serialize proving; the permit is released when `_permit` drops at scope end.
            let _permit = permits.acquire().await.expect("prove semaphore closed");
            let run = {
                let config = config.clone();
                let job_id = job_id.clone();
                let bridge = bridge.clone();
                tokio::task::spawn_blocking(move || {
                    run_prove(&config, &job_id, &bridge, deposit_id)
                })
                .await
            };
            let mut jobs = jobs.lock().unwrap();
            match run {
                Ok(Ok(_proof)) => {
                    // Success is recorded on disk (read_proof_from_disk); drop the in-memory entry.
                    tracing::info!(job = %job_id, "prove: done");
                    jobs.remove(&job_id);
                }
                Ok(Err(e)) => {
                    tracing::warn!(job = %job_id, error = %e, "prove: failed");
                    jobs.insert(job_id.clone(), JobState::Error(e.to_string()));
                }
                Err(e) => {
                    tracing::warn!(job = %job_id, error = %e, "prove: task panicked");
                    jobs.insert(job_id.clone(), JobState::Error(format!("prove task failed: {e}")));
                }
            }
        });
        ProveStatus::Running
    }

    /// Poll the current status of a `job_id` without starting anything.
    pub fn status(&self, job_id: &str) -> ProveStatus {
        if let Some(proof) = read_proof_from_disk(&self.config, job_id) {
            return ProveStatus::Done(proof);
        }
        match self.jobs.lock().unwrap().get(job_id) {
            Some(JobState::Running) => ProveStatus::Running,
            Some(JobState::Error(e)) => ProveStatus::Error(e.clone()),
            None => ProveStatus::NotStarted,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn config_with_prover_dir(dir: PathBuf) -> Config {
        Config {
            bind: "127.0.0.1:0".into(),
            base_rpc: None,
            cast_bin: "cast".into(),
            prover_dir: dir,
            prover_token: Some("tok".into()),
        }
    }

    fn write_proof(config: &Config, job_id: &str) {
        let out = config.out_dir(job_id);
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("seal.bin"), [0u8; 8]).unwrap();
        let mut journal = [0u8; 256];
        journal[24..32].copy_from_slice(&7u64.to_be_bytes());
        journal[32..64].copy_from_slice(&[0xcd; 32]);
        std::fs::write(out.join("journal.bin"), journal).unwrap();
    }

    #[test]
    fn status_is_not_started_before_submit() {
        let tmp = std::env::temp_dir().join(format!("pm-test-{}", std::process::id()));
        let config = config_with_prover_dir(tmp.clone());
        let manager = ProveManager::new(config);
        assert!(matches!(manager.status("nope"), ProveStatus::NotStarted));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn done_is_read_from_disk_across_instances() {
        let tmp = std::env::temp_dir().join(format!("pm-disk-{}", std::process::id()));
        let config = config_with_prover_dir(tmp.clone());
        write_proof(&config, "job1");
        // A fresh manager (as after a restart) still reports Done purely from disk.
        let manager = ProveManager::new(config);
        match manager.status("job1") {
            ProveStatus::Done(p) => {
                assert_eq!(p.block_number, 7);
                assert_eq!(p.block_hash, "cd".repeat(32));
            }
            _ => panic!("expected Done from disk"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn submit_short_circuits_when_already_done() {
        let tmp = std::env::temp_dir().join(format!("pm-submit-{}", std::process::id()));
        let config = config_with_prover_dir(tmp.clone());
        write_proof(&config, "job2");
        let manager = ProveManager::new(config);
        // With artifacts present, submit must not spawn a prover; it returns Done immediately.
        match manager.submit("job2".into(), "0xbridge".into(), 1) {
            ProveStatus::Done(p) => assert_eq!(p.block_number, 7),
            _ => panic!("expected Done"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
