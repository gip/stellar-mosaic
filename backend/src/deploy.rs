use crate::error::{AppError, AppResult};
use crate::models::{Asset, CreateDesk, Desk, Pair};
use crate::AppState;
use uuid::Uuid;

/// Deploy a fresh settlement contract for a new desk and register its assets + pairs.
///
/// Pipeline (mirrors `scripts/06_book_budget_testnet.sh`):
///   1. generate + friendbot-fund a sponsor ("main") keypair
///   2. deploy settlement.wasm with the lift VK + admin = sponsor
///   3. set_vk(2, unshield_vk), set_vk(3, cancel_vk)
///   4. register_asset for each currency (token "native" resolves to the XLM SAC)
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

    // 1. sponsor key
    let (sponsor_pubkey, sponsor_secret) = st.stellar.generate_funded_key(&key_name)?;
    tracing::info!(%sponsor_pubkey, "funded sponsor account");

    // resolve token addresses ("native" -> XLM SAC)
    let xlm_sac = st.stellar.xlm_sac()?;
    let assets: Vec<Asset> = body
        .assets
        .iter()
        .map(|a| Asset {
            asset_id: a.asset_id,
            symbol: a.symbol.clone(),
            token: if a.token == "native" {
                xlm_sac.clone()
            } else {
                a.token.clone()
            },
            decimals: a.decimals,
        })
        .collect();

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
    st.db.insert_desk(&desk, Some(&sponsor_secret))?;
    Ok(desk)
}

fn svec(s: &[&str]) -> Vec<String> {
    s.iter().map(|x| x.to_string()).collect()
}
