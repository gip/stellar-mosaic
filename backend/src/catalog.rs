//! App-wide asset catalog: a dynamic, social registry of cross-chain asset definitions.
//!
//! Each entry links a Stellar side (always present) to an optional Base side. Anyone with a wallet
//! session can propose an asset; the proposer is recorded and shown, and other users can explicitly
//! *trust* an asset. This is off-chain metadata only — proposing does not touch any chain. On-chain
//! support is still set at contract deployment on both Base and Stellar.

use crate::auth::require_session;
use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::models::CatalogAsset;
use crate::AppState;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/assets", get(list_assets).post(propose_asset))
        .route(
            "/assets/:id/trust",
            post(trust_asset).delete(untrust_asset),
        )
}

#[derive(Serialize)]
pub struct CatalogAssetView {
    #[serde(flatten)]
    pub asset: CatalogAsset,
    pub trust_count: i64,
    pub trusted_by_me: bool,
}

#[derive(Deserialize)]
pub struct ProposeAsset {
    pub symbol: String,
    pub stellar_token: Option<String>,
    pub stellar_decimals: Option<u32>,
    pub base_chain_id: Option<i64>,
    pub base_token: Option<String>,
    pub base_decimals: Option<u32>,
}

/// List the whole catalog with trust counts. Public, but resolves the optional session so the
/// caller learns which assets they already trust.
async fn list_assets(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<CatalogAssetView>>> {
    let viewer = require_session(&headers, &st).await.ok().map(|s| s.address);
    let rows = st.db.list_catalog_assets(viewer.as_deref()).await?;
    Ok(Json(
        rows.into_iter()
            .map(|(asset, trust_count, trusted_by_me)| CatalogAssetView {
                asset,
                trust_count,
                trusted_by_me,
            })
            .collect(),
    ))
}

/// Propose a new catalog asset. The proposer is the session wallet and auto-trusts it.
async fn propose_asset(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ProposeAsset>,
) -> AppResult<Json<CatalogAssetView>> {
    let session = require_session(&headers, &st).await?;

    let symbol = body.symbol.trim().to_uppercase();
    if symbol.is_empty() || symbol.len() > 12 {
        return Err(AppError::BadRequest(
            "symbol must be 1-12 characters".into(),
        ));
    }

    // An asset can be on Stellar, Base, or both, but must be on at least one chain.
    let stellar_in = body.stellar_token.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let base_in = body.base_token.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if stellar_in.is_none() && base_in.is_none() {
        return Err(AppError::BadRequest(
            "an asset must be on Stellar, Base, or both".into(),
        ));
    }

    // Stellar side: "native" is XLM, otherwise a CODE:ISSUER or C... contract. Decimals default 7.
    let (stellar_token, stellar_decimals) = match stellar_in {
        Some(t) => (
            Some(validate_stellar_token(t)?),
            Some(body.stellar_decimals.unwrap_or(7)),
        ),
        None => (None, None),
    };

    // Base side: "native" is ETH (no address, default 18 decimals); otherwise an ERC20 address
    // whose decimals must be supplied. A chain id is always required for a Base asset.
    let (base_chain_id, base_token, base_decimals) = match base_in {
        Some(t) => {
            let token = validate_base_token(t)?;
            let chain = body
                .base_chain_id
                .ok_or_else(|| AppError::BadRequest("base_chain_id required for a Base asset".into()))?;
            let decimals = if token == "native" {
                body.base_decimals.unwrap_or(18)
            } else {
                body.base_decimals.ok_or_else(|| {
                    AppError::BadRequest("base_decimals required for an ERC20".into())
                })?
            };
            (Some(chain), Some(token), Some(decimals))
        }
        None => (None, None, None),
    };

    if st
        .db
        .catalog_asset_exists_tokens(stellar_token.as_deref(), base_token.as_deref())
        .await?
    {
        return Err(AppError::Conflict(
            "an asset with this token configuration already exists".into(),
        ));
    }

    let asset = CatalogAsset {
        id: Uuid::new_v4().to_string(),
        symbol,
        stellar_token,
        stellar_decimals,
        base_chain_id,
        base_token,
        base_decimals,
        proposer_address: Some(session.address.clone()),
        is_default: false,
        created_at: now_ms(),
    };
    st.db.insert_catalog_asset(&asset).await?;
    st.db.add_asset_trust(&asset.id, &session.address).await?;
    Ok(Json(CatalogAssetView {
        asset,
        trust_count: 1,
        trusted_by_me: true,
    }))
}

async fn trust_asset(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let session = require_session(&headers, &st).await?;
    if !st.db.catalog_asset_exists(&id).await? {
        return Err(AppError::NotFound(format!("asset {id}")));
    }
    st.db.add_asset_trust(&id, &session.address).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn untrust_asset(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let session = require_session(&headers, &st).await?;
    st.db.remove_asset_trust(&id, &session.address).await?;
    Ok(Json(json!({ "ok": true })))
}

/// Validate a Stellar token reference without touching the chain: `native`, `CODE:ISSUER`, or a
/// `C...` contract id. A bare `G...` issuer is rejected (mirrors `deploy::resolve_token`).
fn validate_stellar_token(token: &str) -> AppResult<String> {
    let t = token.trim();
    let err = || {
        AppError::BadRequest(
            "stellar_token must be \"native\", \"CODE:ISSUER\", or a C... contract id".into(),
        )
    };
    if t == "native" {
        Ok(t.to_string())
    } else if let Some((code, issuer)) = t.split_once(':') {
        if code.is_empty() || code.len() > 12 || !issuer.starts_with('G') || issuer.len() != 56 {
            return Err(err());
        }
        Ok(t.to_string())
    } else if t.starts_with('C') && t.len() == 56 {
        Ok(t.to_string())
    } else {
        Err(err())
    }
}

/// Validate a Base token: `"native"` (ETH) or an ERC20 address — exactly `0x` + 40 hex digits
/// (mirrors `enqueue_base_shield`).
fn validate_base_token(token: &str) -> AppResult<String> {
    let t = token.trim();
    if t == "native" {
        Ok("native".to_string())
    } else if t.len() == 42 && t.starts_with("0x") && t[2..].bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(t.to_string())
    } else {
        Err(AppError::BadRequest(
            "base_token must be \"native\" (ETH) or a 0x EVM address".into(),
        ))
    }
}
