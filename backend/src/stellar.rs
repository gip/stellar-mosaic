use crate::config::Config;
use crate::error::{AppError, AppResult};
use std::path::Path;
use std::process::Command;

/// Thin wrapper over the `stellar` CLI. We shell out to the already-validated recipe in
/// `scripts/0{4,6}_*.sh` rather than reimplement Soroban tx assembly. Read calls simulate
/// (no `--send`); write/relay calls add `--send yes` and a signing source (the sponsor secret).
#[derive(Clone)]
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

    // WS4 removed the on-chain `book()` method — the order book is reconstructed off-chain from
    // `orderins`/`nfspent` events (see indexer::order_book), so there is no `book` invocation here.

    // ---- write / deploy path (Phase 2+) ----

    /// The Stellar Asset Contract address for native XLM on this network.
    pub fn xlm_sac(&self) -> AppResult<String> {
        self.asset_sac("native")
    }

    /// The Stellar Asset Contract address for an asset descriptor. `asset` is either `native` or a
    /// classic asset `CODE:ISSUER` (e.g. `USDC:GBBD...`). This only *derives* the deterministic
    /// contract id; it does not check whether the SAC is deployed (see `ensure_asset_sac`).
    pub fn asset_sac(&self, asset: &str) -> AppResult<String> {
        self.run(&[
            "contract".into(),
            "id".into(),
            "asset".into(),
            "--asset".into(),
            asset.into(),
            "--network".into(),
            self.network.clone(),
        ])
    }

    /// Derive the SAC contract id for a classic asset `CODE:ISSUER` and ensure it is deployed
    /// on-chain (idempotent — a "contract already exists" error is treated as success). Returns
    /// the SAC contract id. Needed because a non-native asset's SAC may not be wrapped yet, in
    /// which case the settlement contract's `shield`/`transfer` call would trap.
    pub fn ensure_asset_sac(&self, asset: &str, source: &str) -> AppResult<String> {
        let id = self.asset_sac(asset)?;
        match self.run(&[
            "contract".into(),
            "asset".into(),
            "deploy".into(),
            "--asset".into(),
            asset.into(),
            "--source-account".into(),
            source.into(),
            "--network".into(),
            self.network.clone(),
        ]) {
            Ok(_) => {}
            // Already wrapped on a previous run / by someone else — fine, the id is still valid.
            Err(AppError::Stellar(msg))
                if msg.contains("already been used")
                    || msg.contains("already exists")
                    || msg.contains("ExistingValue") => {}
            Err(e) => return Err(e),
        }
        Ok(id)
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

    /// Fetch one page of contract events as JSONL (one event object per line). Provide either a
    /// `start_ledger` or a `cursor`. Returns raw stdout.
    pub fn events_page(
        &self,
        contract_id: &str,
        start_ledger: Option<u64>,
        cursor: Option<&str>,
        count: u32,
    ) -> AppResult<String> {
        let mut args = vec![
            "events".into(),
            "--network".into(),
            self.network.clone(),
            "--id".into(),
            contract_id.into(),
            "--output".into(),
            "json".into(),
            "--count".into(),
            count.to_string(),
        ];
        if let Some(c) = cursor {
            args.push("--cursor".into());
            args.push(c.into());
        } else {
            args.push("--start-ledger".into());
            args.push(start_ledger.unwrap_or(1).to_string());
        }
        self.run(&args)
    }

    /// The oldest ledger currently retained by the RPC (parsed from the out-of-range error).
    pub fn oldest_ledger(&self, contract_id: &str) -> AppResult<u64> {
        match self.events_page(contract_id, Some(1), None, 1) {
            Ok(_) => Ok(1),
            Err(AppError::Stellar(msg)) => parse_range(&msg)
                .map(|(o, _)| o)
                .ok_or_else(|| AppError::Stellar(format!("cannot parse ledger range from: {msg}"))),
            Err(e) => Err(e),
        }
    }

    /// The latest ledger known to the RPC (parsed from the out-of-range error). Used to stamp a
    /// desk's `from_ledger` at creation so later event scans start near its activity.
    pub fn latest_ledger(&self, contract_id: &str) -> AppResult<u64> {
        match self.events_page(contract_id, Some(1), None, 1) {
            Ok(_) => Ok(1),
            Err(AppError::Stellar(msg)) => parse_range(&msg)
                .map(|(_, l)| l)
                .ok_or_else(|| AppError::Stellar(format!("cannot parse ledger range from: {msg}"))),
            Err(e) => Err(e),
        }
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

    /// Relayer attestation of a canonical Base block hash (WS6 trust anchor). `block_hash` is the
    /// 64-hex digest (no 0x). Signed by the desk admin/relayer `source`.
    pub fn attest_base_block(
        &self,
        contract_id: &str,
        source: &str,
        block_number: u64,
        block_hash: &str,
    ) -> AppResult<String> {
        self.invoke_write(
            contract_id,
            source,
            &[
                "attest_base_block".into(),
                "--block_number".into(),
                block_number.to_string(),
                "--block_hash".into(),
                block_hash.to_string(),
            ],
        )
    }

    /// Verify a RISC Zero receipt and mint the bridged note. `seal`/`journal` are files of raw bytes
    /// (the prover's seal.bin / journal.bin).
    pub fn shield_from_base(
        &self,
        contract_id: &str,
        source: &str,
        seal: &Path,
        journal: &Path,
    ) -> AppResult<String> {
        self.invoke_write(
            contract_id,
            source,
            &[
                "shield_from_base".into(),
                "--seal-file-path".into(),
                seal.to_string_lossy().into(),
                "--journal-file-path".into(),
                journal.to_string_lossy().into(),
            ],
        )
    }
}

/// Parse `(oldest, latest)` from an RPC error like
/// "startLedger must be within the ledger range: 3057139 - 3178098", tolerating trailing junk.
fn parse_range(msg: &str) -> Option<(u64, u64)> {
    let after = msg.split("ledger range:").nth(1)?;
    let nums: Vec<u64> = after
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    match nums.as_slice() {
        [oldest, latest, ..] => Some((*oldest, *latest)),
        _ => None,
    }
}

impl Stellar {
    /// Add the sponsor's envelope signature to a frontend-built transaction (whose Soroban auth
    /// entries are already user-signed) and submit it. Used for sponsored `shield`.
    pub fn sign_and_send(&self, tx_xdr: &str, sponsor_secret: &str) -> AppResult<String> {
        let signed = self.run(&[
            "tx".into(),
            "sign".into(),
            tx_xdr.into(),
            "--sign-with-key".into(),
            sponsor_secret.into(),
            "--network".into(),
            self.network.clone(),
        ])?;
        let out = self.run(&[
            "tx".into(),
            "send".into(),
            signed.trim().into(),
            "--network".into(),
            self.network.clone(),
        ])?;
        // `tx send` prints the full envelope JSON; return just status + hash.
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&out) {
            let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("");
            let hash = v.get("tx_hash").and_then(|s| s.as_str()).unwrap_or("");
            return Ok(format!("{status} {hash}").trim().to_string());
        }
        Ok(out)
    }
}

fn is_contract_id(t: &str) -> bool {
    t.len() == 56
        && t.starts_with('C')
        && t.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}
