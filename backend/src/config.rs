use std::path::PathBuf;

/// Runtime configuration for the prove service, read from the environment with sensible defaults.
///
/// This service does one thing: prove Base deposits with the `bridge-prover` (STARK -> Groth16) and
/// serve the artifacts over an async submit/poll HTTP API. It holds no desk state and never talks to
/// Stellar — the MCP server owns finality waiting and the on-chain `shield_from_base` submission.
#[derive(Clone, Debug)]
pub struct Config {
    /// Bind address for the HTTP server.
    pub bind: String,
    /// Base (Sepolia) RPC URL. Required to prove; when unset, prove requests are rejected.
    pub base_rpc: Option<String>,
    /// `cast` (foundry) binary, used to read the Base chain head the proof commits to.
    pub cast_bin: String,
    /// Directory of the `bridge-prover` workspace (must contain the `run-host` launcher). Proof
    /// artifacts are written under `<prover_dir>/out/<job_id>/`.
    pub prover_dir: PathBuf,
    /// Bearer token required on the prove endpoints. If unset, every prove request is rejected.
    pub prover_token: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        Config {
            bind: env("MOSAIC_BIND", "127.0.0.1:8787"),
            base_rpc: std::env::var("MOSAIC_BASE_RPC")
                .ok()
                .filter(|s| !s.is_empty()),
            cast_bin: env("MOSAIC_CAST_BIN", "cast"),
            prover_dir: PathBuf::from(env(
                "MOSAIC_PROVER_DIR",
                cwd.join("bridge-prover").to_string_lossy().as_ref(),
            )),
            prover_token: std::env::var("MOSAIC_PROVER_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),
        }
    }

    /// The per-job proof output directory (`<prover_dir>/out/<job_id>/`). Its presence of both
    /// `seal.bin` and `journal.bin` is the durable "this proof is done" signal across restarts.
    pub fn out_dir(&self, job_id: &str) -> PathBuf {
        self.prover_dir.join("out").join(job_id)
    }
}

fn env(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}
