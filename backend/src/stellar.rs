use crate::config::Config;
use crate::error::{AppError, AppResult};
use std::process::Command;

/// Thin wrapper over the `stellar` CLI. We shell out to the already-validated recipe in
/// `scripts/0{4,6}_*.sh` rather than reimplement Soroban tx assembly. Read calls simulate
/// (no `--send`); write/relay calls (Phase 2+) add `--send yes` and a signing source.
pub struct Stellar {
    bin: String,
    network: String,
}

impl Stellar {
    pub fn new(cfg: &Config) -> Self {
        Stellar {
            bin: cfg.stellar_bin.clone(),
            network: cfg.network.clone(),
        }
    }

    /// Run the CLI with the given args, returning trimmed stdout on success.
    fn run(&self, args: &[String]) -> AppResult<String> {
        let out = Command::new(&self.bin)
            .args(args)
            .output()
            .map_err(|e| AppError::Stellar(format!("spawn {}: {e}", self.bin)))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(AppError::Stellar(format!(
                "`{} {}` failed: {}",
                self.bin,
                args.join(" "),
                stderr.trim()
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// Read-only contract call (simulation). `source` may be a key name or a G... public key.
    /// `call_args` are the function name and its `--flag value` pairs.
    pub fn invoke_read(
        &self,
        contract_id: &str,
        source: &str,
        call_args: &[&str],
    ) -> AppResult<String> {
        let mut args = vec![
            "contract".into(),
            "invoke".into(),
            "--id".into(),
            contract_id.into(),
            "--source-account".into(),
            source.into(),
            "--network".into(),
            self.network.clone(),
            "--".into(),
        ];
        args.extend(call_args.iter().map(|s| s.to_string()));
        self.run(&args)
    }

    /// `root()` -> 0x-hex string (quotes stripped).
    pub fn root(&self, contract_id: &str, source: &str) -> AppResult<String> {
        let raw = self.invoke_read(contract_id, source, &["root"])?;
        Ok(raw.trim().trim_matches('"').to_string())
    }

    /// `book(pair_id, side)` -> parsed JSON value (a list of OrderEntry).
    pub fn book(
        &self,
        contract_id: &str,
        source: &str,
        pair_id: u32,
        side: u32,
    ) -> AppResult<serde_json::Value> {
        let pair = pair_id.to_string();
        let side_s = side.to_string();
        let raw = self.invoke_read(
            contract_id,
            source,
            &["book", "--pair_id", &pair, "--side", &side_s],
        )?;
        serde_json::from_str(&raw)
            .map_err(|e| AppError::Stellar(format!("parse book json: {e}; raw={raw}")))
    }
}
