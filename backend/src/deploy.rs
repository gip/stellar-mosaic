use crate::error::{AppError, AppResult};
use crate::models::{Asset, AssetKind, CreateDesk, Desk, Pair};
use crate::AppState;
use serde_json::json;
use uuid::Uuid;

/// Deploy a fresh settlement contract for a new desk. Assets and pairs are now CONSTRUCTOR-ONLY
/// (immutable): they are passed to `__constructor` as JSON, so a desk can never be half-configured.
///
/// Pipeline:
///   1. generate + friendbot-fund a sponsor ("main") keypair
///   2. deploy settlement.wasm with all immutable operation VKs + admin = sponsor + the asset set
///      (each with its `AssetKind`) + the canonical pairs (pair_id assigned in array order from 0)
///
/// This makes blocking CLI calls; run it via `spawn_blocking`.
pub fn create_desk(st: &AppState, body: CreateDesk) -> AppResult<(Desk, String, Option<u64>)> {
    if body.assets.is_empty() {
        return Err(AppError::BadRequest("at least one asset required".into()));
    }
    let cfg = &st.config;
    let wasm = cfg.wasm_path();
    if !wasm.exists() {
        return Err(AppError::BadRequest(format!(
            "settlement.wasm not found at {} — build it first (see backend/README.md)",
            wasm.display()
        )));
    }

    let desk_id = Uuid::new_v4().to_string();
    let key_name = format!("desk-{}", &desk_id[..8]);

    // resolve token addresses (see `resolve_token`); "native" -> XLM SAC
    let xlm_sac = st.stellar.xlm_sac()?;

    // Stamp the current latest ledger so later event scans start near this desk's activity.
    let from_ledger = st.stellar.latest_ledger(&xlm_sac).ok();

    // 1. sponsor key
    let (sponsor_pubkey, sponsor_secret) = st.stellar.generate_funded_key(&key_name)?;
    tracing::info!(%sponsor_pubkey, "funded sponsor account");

    // Resolve each desk asset: a Stellar/Dual asset gets its real SAC token; a BaseRepresented asset
    // has no Stellar token (it only lives as a note). The on-chain `AssetDef.token` is the SAC for
    // the former and `None` for the latter.
    let assets: Vec<Asset> = body
        .assets
        .iter()
        .map(|a| {
            let token = if a.kind == AssetKind::BaseRepresented {
                // Kept as a display sentinel off-chain; never used for a transfer.
                "represented".to_string()
            } else {
                resolve_token(st, &a.token, &xlm_sac, &sponsor_secret)?
            };
            Ok(Asset {
                asset_id: a.asset_id,
                symbol: a.symbol.clone(),
                token,
                decimals: a.decimals,
                kind: a.kind,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;

    // Constructor JSON: Vec<AssetInit> ({asset_id, token: Option<Address>, kind}) and Vec<PairDef>.
    let assets_json = json!(assets
        .iter()
        .map(|a| json!({
            "asset_id": a.asset_id,
            "token": if a.kind == AssetKind::BaseRepresented { serde_json::Value::Null } else { json!(a.token) },
            "kind": a.kind.as_str(),
        }))
        .collect::<Vec<_>>())
    .to_string();
    let pairs: Vec<Pair> = body
        .pairs
        .iter()
        .enumerate()
        .map(|(i, p)| Pair { pair_id: i as u32, base_asset: p.base_asset, quote_asset: p.quote_asset })
        .collect();
    let pairs_json = json!(pairs
        .iter()
        .map(|p| json!({ "base_asset": p.base_asset, "quote_asset": p.quote_asset }))
        .collect::<Vec<_>>())
    .to_string();

    // 2. deploy with the full, immutable asset/pair config baked into the constructor.
    let contract_id = st.stellar.deploy(
        &wasm,
        &cfg.lift_vk(),
        &cfg.unshield_vk(),
        &cfg.cancel_vk(),
        &cfg.join_vk(),
        &sponsor_pubkey,
        &assets_json,
        &pairs_json,
        &sponsor_secret,
    )?;
    tracing::info!(%contract_id, "deployed settlement contract");

    let desk = Desk {
        id: desk_id,
        name: body.name,
        contract_id,
        sponsor_pubkey,
        event_start_ledger: from_ledger,
        assets,
        pairs,
        base_deployment: None,
    };
    Ok((desk, sponsor_secret, from_ledger))
}

/// Resolve a user-supplied `token` field into a Soroban SAC contract address (`C...`):
///   - `"native"`                 -> the XLM SAC
///   - `"CODE:ISSUER"` (classic)  -> derive its SAC id and ensure it is deployed on-chain
///   - `"C..."` (contract id)     -> used as-is (assumed already deployed)
///
/// A bare `G...` issuer is rejected: a SAC id is derived from *both* the asset code and the
/// issuer, so the code is required — pass `CODE:ISSUER` instead.
fn resolve_token(st: &AppState, token: &str, xlm_sac: &str, source: &str) -> AppResult<String> {
    if token == "native" {
        Ok(xlm_sac.to_string())
    } else if token.contains(':') {
        st.stellar.ensure_asset_sac(token, source)
    } else if token.starts_with('G') {
        Err(AppError::BadRequest(format!(
            "token \"{token}\" is an issuer account, not a contract. Use \"CODE:ISSUER\" \
             (e.g. \"USDC:{token}\") so the Stellar Asset Contract address can be derived, \
             or pass the SAC contract id directly (C...)."
        )))
    } else {
        Ok(token.to_string())
    }
}
