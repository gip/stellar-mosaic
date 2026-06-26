use crate::error::{AppError, AppResult};
use crate::models::Desk;
use crate::AppState;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Deserialize)]
pub struct ValidateRelay {
    pub action: String,
    pub desk: Desk,
    pub request: Value,
    pub address: Option<String>,
    pub tx_xdr: Option<String>,
    pub public_inputs_b64: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ValidateRelayResponse {
    pub ok: bool,
}

fn require_token(headers: &HeaderMap, st: &AppState) -> AppResult<()> {
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

pub async fn validate_relay(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ValidateRelay>,
) -> AppResult<Json<ValidateRelayResponse>> {
    require_token(&headers, &st)?;
    if body.action == "relay_shield" {
        crate::handlers::validate_shield_xdr(
            body.tx_xdr
                .as_deref()
                .ok_or_else(|| AppError::BadRequest("tx_xdr required".into()))?,
            &body.desk,
            body.address
                .as_deref()
                .ok_or_else(|| AppError::BadRequest("address required".into()))?,
            &body.request,
        )?;
    } else {
        let public_inputs_b64 = body
            .public_inputs_b64
            .as_deref()
            .ok_or_else(|| AppError::BadRequest("public_inputs_b64 required".into()))?;
        let pi = base64::engine::general_purpose::STANDARD
            .decode(public_inputs_b64.trim())
            .map_err(|e| AppError::BadRequest(format!("public_inputs_b64: {e}")))?;
        crate::handlers::validate_public_inputs(&body.action, &body.request, &pi, &body.desk)?;
    }
    Ok(Json(ValidateRelayResponse { ok: true }))
}
