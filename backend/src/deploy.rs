use crate::error::{AppError, AppResult};
use crate::models::{Asset, CreateDesk, Desk, Pair};
use crate::AppState;
use uuid::Uuid;

/// Deploy a fresh settlement contract for a new desk and register its assets + pairs.
///
/// Pipeline (mirrors `scripts/06_book_budget_testnet.sh`):
///   1. generate + friendbot-fund a sponsor ("main") keypair
///   2. deploy settlement.wasm with the lift VK + admin = sponsor
///   3. set_vk(2, unshield_vk), set_vk(3, cancel_vk), set_vk(4, join_vk)
///   4. register_asset for each currency (see `resolve_token` for how `token` is resolved to a SAC)
///   5. register_pair for each pair (pair_id assigned sequentially from 0)
///
/// This makes blocking CLI calls; run it via `spawn_blocking`.
pub fn create_desk(st: &AppState, body: CreateDesk) -> AppResult<Desk> {
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

    let assets: Vec<Asset> = body
        .assets
        .iter()
        .map(|a| {
            Ok(Asset {
                asset_id: a.asset_id,
                symbol: a.symbol.clone(),
                token: resolve_token(st, &a.token, &xlm_sac, &sponsor_secret)?,
                decimals: a.decimals,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;

    // 2. deploy
    let contract_id = st
        .stellar
        .deploy(&wasm, &cfg.lift_vk(), &sponsor_pubkey, &sponsor_secret)?;
    tracing::info!(%contract_id, "deployed settlement contract");

    // 3. extra VKs
    let inv = |args: Vec<String>| st.stellar.invoke_write(&contract_id, &sponsor_secret, &args);
    inv(svec(&[
        "set_vk",
        "--op",
        "2",
        "--vk_bytes-file-path",
        &cfg.unshield_vk().to_string_lossy(),
    ]))?;
    inv(svec(&[
        "set_vk",
        "--op",
        "3",
        "--vk_bytes-file-path",
        &cfg.cancel_vk().to_string_lossy(),
    ]))?;
    inv(svec(&[
        "set_vk",
        "--op",
        "4",
        "--vk_bytes-file-path",
        &cfg.join_vk().to_string_lossy(),
    ]))?;

    // 4. assets
    for a in &assets {
        inv(svec(&[
            "register_asset",
            "--asset_id",
            &a.asset_id.to_string(),
            "--token",
            &a.token,
        ]))?;
    }

    // 5. pairs (pair_id is assigned sequentially from 0 in registration order)
    let mut pairs = Vec::new();
    for (i, p) in body.pairs.iter().enumerate() {
        inv(svec(&[
            "register_pair",
            "--base_asset",
            &p.base_asset.to_string(),
            "--quote_asset",
            &p.quote_asset.to_string(),
        ]))?;
        pairs.push(Pair {
            pair_id: i as u32,
            base_asset: p.base_asset,
            quote_asset: p.quote_asset,
        });
    }

    let desk = Desk {
        id: desk_id,
        name: body.name,
        contract_id,
        sponsor_pubkey,
        assets,
        pairs,
    };
    st.db.insert_desk(&desk, Some(&sponsor_secret), from_ledger)?;
    Ok(desk)
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

fn svec(s: &[&str]) -> Vec<String> {
    s.iter().map(|x| x.to_string()).collect()
}
