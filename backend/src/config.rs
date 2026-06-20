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
    /// Directory holding the build output `settlement.wasm` (git-ignored).
    pub artifacts_dir: PathBuf,
    /// Directory holding the committed lift/unshield/cancel VK files used at deploy.
    pub vks_dir: PathBuf,
    /// Fallback source identity (a `stellar keys` name) for read-only simulations on desks that
    /// have no stored sponsor key (e.g. imported desks). Reads never submit, so this only needs to
    /// resolve to a valid account address.
    pub read_identity: String,
}

impl Config {
    pub fn from_env() -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        Config {
            bind: env("MOSAIC_BIND", "127.0.0.1:8787"),
            network: env("MOSAIC_NETWORK", "testnet"),
            stellar_bin: env("MOSAIC_STELLAR_BIN", "stellar"),
            db_path: PathBuf::from(env(
                "MOSAIC_DB",
                cwd.join("data").join("mosaic.db").to_string_lossy().as_ref(),
            )),
            artifacts_dir: PathBuf::from(env(
                "MOSAIC_ARTIFACTS",
                cwd.join("artifacts").to_string_lossy().as_ref(),
            )),
            vks_dir: PathBuf::from(env(
                "MOSAIC_VKS",
                cwd.join("vks").to_string_lossy().as_ref(),
            )),
            read_identity: env("MOSAIC_READ_IDENTITY", "m0"),
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
}

fn env(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}
