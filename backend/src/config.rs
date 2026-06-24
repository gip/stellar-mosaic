use std::path::PathBuf;

/// Runtime configuration, read from the environment with sensible testnet defaults.
#[derive(Clone, Debug)]
pub struct Config {
    /// Bind address for the HTTP server.
    pub bind: String,
    /// Stellar network passphrase name understood by the CLI (e.g. `testnet`).
    pub network: String,
    /// Path to the `stellar` CLI binary.
    pub stellar_bin: String,
    /// SQLite database file.
    pub db_path: PathBuf,
    /// SQLx database URL. PostgreSQL is required for multi-instance production; SQLite is used
    /// for local development. `MOSAIC_DB` remains a compatibility fallback.
    pub database_url: String,
    /// Directory holding the build output `settlement.wasm` (git-ignored).
    pub artifacts_dir: PathBuf,
    /// Directory holding the committed lift/unshield/cancel VK files used at deploy.
    pub vks_dir: PathBuf,
    /// Fallback source identity (a `stellar keys` name) for read-only simulations on desks that
    /// have no stored sponsor key (e.g. imported desks). Reads never submit, so this only needs to
    /// resolve to a valid account address.
    pub read_identity: String,
    /// Base (Sepolia) RPC URL. When set, the Base-shield worker (WS6) runs; when unset it is
    /// disabled and `base_shields` jobs are never advanced.
    pub base_rpc: Option<String>,
    /// `cast` (foundry) binary, used to read the Base chain head + finalized block.
    pub cast_bin: String,
    /// Directory of the `bridge-prover` workspace (must contain the `run-host` launcher).
    pub prover_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let db_path = PathBuf::from(env(
            "MOSAIC_DB",
            cwd.join("data")
                .join("mosaic.db")
                .to_string_lossy()
                .as_ref(),
        ));
        let database_url = std::env::var("MOSAIC_DATABASE_URL").unwrap_or_else(|_| {
            if db_path == std::path::Path::new(":memory:") {
                "sqlite::memory:".into()
            } else {
                format!("sqlite://{}?mode=rwc", db_path.to_string_lossy())
            }
        });
        Config {
            bind: env("MOSAIC_BIND", "127.0.0.1:8787"),
            network: env("MOSAIC_NETWORK", "testnet"),
            stellar_bin: env("MOSAIC_STELLAR_BIN", "stellar"),
            db_path,
            database_url,
            artifacts_dir: PathBuf::from(env(
                "MOSAIC_ARTIFACTS",
                cwd.join("artifacts").to_string_lossy().as_ref(),
            )),
            vks_dir: PathBuf::from(env(
                "MOSAIC_VKS",
                cwd.join("vks").to_string_lossy().as_ref(),
            )),
            read_identity: env("MOSAIC_READ_IDENTITY", "m0"),
            base_rpc: std::env::var("MOSAIC_BASE_RPC").ok().filter(|s| !s.is_empty()),
            cast_bin: env("MOSAIC_CAST_BIN", "cast"),
            prover_dir: PathBuf::from(env(
                "MOSAIC_PROVER_DIR",
                cwd.join("bridge-prover").to_string_lossy().as_ref(),
            )),
        }
    }
}

impl Config {
    pub fn wasm_path(&self) -> PathBuf {
        self.artifacts_dir.join("settlement.wasm")
    }
    pub fn lift_vk(&self) -> PathBuf {
        self.vks_dir.join("lift_vk")
    }
    pub fn unshield_vk(&self) -> PathBuf {
        self.vks_dir.join("unshield_vk")
    }
    pub fn cancel_vk(&self) -> PathBuf {
        self.vks_dir.join("cancel_vk")
    }
    pub fn join_vk(&self) -> PathBuf {
        self.vks_dir.join("join_vk")
    }
    pub fn match_vk(&self) -> PathBuf {
        self.vks_dir.join("match_vk")
    }
}

fn env(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}
