use crate::error::{AppError, AppResult};
use crate::AppState;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

#[derive(Debug, Deserialize)]
pub struct ProveBaseDeposit {
    pub bridge: String,
    pub deposit_id: i64,
}

fn require_prover_token(headers: &HeaderMap, st: &AppState) -> AppResult<()> {
    let Some(expected) = st.config.prover_token.as_deref() else {
        return Err(AppError::Unauthorized(
            "MOSAIC_PROVER_TOKEN is not configured".into(),
        ));
    };
    let actual = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| AppError::Unauthorized("bearer token required".into()))?;
    if actual != expected {
        return Err(AppError::Unauthorized("invalid prover token".into()));
    }
    Ok(())
}

pub async fn prove_base_deposit(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ProveBaseDeposit>,
) -> AppResult<Json<crate::base_shield::BaseDepositProof>> {
    require_prover_token(&headers, &st)?;
    Ok(Json(
        crate::base_shield::prove_base_deposit(&st.config, body.bridge, body.deposit_id).await?,
    ))
}
