use crate::config::Config;
use crate::error::{AppError, AppResult};
use std::path::Path;
use std::process::Command;

/// Thin wrapper over the `stellar` CLI. We shell out to the already-validated recipe in
/// `scripts/0{4,6}_*.sh` rather than reimplement Soroban tx assembly. Read calls simulate
/// (no `--send`); write/relay calls add `--send yes` and a signing source (the sponsor secret).
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

    // ---- write / deploy path (Phase 2+) ----

    /// The Stellar Asset Contract address for native XLM on this network.
    pub fn xlm_sac(&self) -> AppResult<String> {
        self.run(&[
            "contract".into(),
            "id".into(),
            "asset".into(),
            "--asset".into(),
            "native".into(),
            "--network".into(),
            self.network.clone(),
        ])
    }

    /// Generate a new identity in the keystore and fund it via friendbot.
    /// Returns `(public_key G..., secret S...)`.
    pub fn generate_funded_key(&self, name: &str) -> AppResult<(String, String)> {
        self.run(&[
            "keys".into(),
            "generate".into(),
            name.into(),
            "--network".into(),
            self.network.clone(),
            "--fund".into(),
            "--overwrite".into(),
        ])?;
        let pubkey = self.run(&["keys".into(), "address".into(), name.into()])?;
        let secret = self.run(&["keys".into(), "secret".into(), name.into()])?;
        Ok((pubkey, secret))
    }

    /// Deploy the settlement wasm with the lift VK + admin set in the constructor.
    /// `source` is a signing source (secret key or identity name). Returns the contract id.
    pub fn deploy(
        &self,
        wasm: &Path,
        lift_vk: &Path,
        admin: &str,
        source: &str,
    ) -> AppResult<String> {
        let out = self.run(&[
            "contract".into(),
            "deploy".into(),
            "--wasm".into(),
            wasm.to_string_lossy().into(),
            "--source-account".into(),
            source.into(),
            "--network".into(),
            self.network.clone(),
            "--".into(),
            "--vk_bytes-file-path".into(),
            lift_vk.to_string_lossy().into(),
            "--admin".into(),
            admin.into(),
        ])?;
        // stdout may carry a few log lines; the contract id is the C... token.
        out.split_whitespace()
            .find(|t| is_contract_id(t))
            .map(|s| s.to_string())
            .ok_or_else(|| AppError::Stellar(format!("no contract id in deploy output: {out}")))
    }

    /// Submit a state-changing contract call signed by `source`. `call_args` is the function name
    /// and its `--flag value` pairs. Returns trimmed stdout (the call's return value, if any).
    pub fn invoke_write(
        &self,
        contract_id: &str,
        source: &str,
        call_args: &[String],
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
            "--send".into(),
            "yes".into(),
            "--".into(),
        ];
        args.extend(call_args.iter().cloned());
        self.run(&args)
    }
}

fn is_contract_id(t: &str) -> bool {
    t.len() == 56 && t.starts_with('C') && t.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}
