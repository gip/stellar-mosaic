use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::AppState;
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

const COOKIE: &str = "mosaic_session";
const SIGNED_MESSAGE_PREFIX: &str = "Stellar Signed Message:\n";

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/auth/challenges", post(challenge))
        .route(
            "/auth/sessions",
            post(create_session).delete(delete_session),
        )
        .route("/auth/session", get(get_session))
}

#[derive(Deserialize)]
struct ChallengeRequest {
    address: String,
}

async fn challenge(
    axum::extract::State(st): axum::extract::State<Arc<AppState>>,
    Json(body): Json<ChallengeRequest>,
) -> AppResult<Json<Value>> {
    decode_public_key(&body.address)?;
    let mut nonce = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce);
    let expires_at = now_ms() + 5 * 60_000;
    let message = format!(
        "Sign in to Stellar Mosaic\n\nAddress: {}\nNetwork: {}\nNonce: {}\nExpires: {}\n\nThis signature cannot decrypt your private notes.",
        body.address, st.config.network, base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(nonce), expires_at
    );
    let challenge_id = st
        .db
        .create_challenge(&body.address, &message, expires_at)
        .await?;
    Ok(Json(
        json!({"challenge_id":challenge_id,"message":message,"expires_at":expires_at}),
    ))
}

#[derive(Deserialize)]
struct SessionRequest {
    challenge_id: String,
    signature: String,
}

async fn create_session(
    axum::extract::State(st): axum::extract::State<Arc<AppState>>,
    Json(body): Json<SessionRequest>,
) -> AppResult<Response> {
    let (address, message) = st.db.consume_challenge(&body.challenge_id).await?;
    verify_signature(&address, &message, &body.signature)?;
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
    let expires_at = now_ms() + 24 * 60 * 60_000;
    st.db
        .create_session(&token, &address, &st.config.network, expires_at)
        .await?;
    let mut response =
        Json(json!({"address":address,"network":st.config.network,"expires_at":expires_at}))
            .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400"
        ))
        .unwrap(),
    );
    Ok(response)
}

async fn get_session(
    axum::extract::State(st): axum::extract::State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let session = require_session(&headers, &st).await?;
    Ok(Json(
        json!({"address":session.address,"network":session.network}),
    ))
}

async fn delete_session(
    axum::extract::State(st): axum::extract::State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Response> {
    if let Some(token) = cookie_token(&headers) {
        st.db.delete_session(token).await?;
    }
    let mut response = Json(json!({"ok":true})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static("mosaic_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"),
    );
    Ok(response)
}

#[derive(Clone, Debug)]
pub struct Session {
    pub address: String,
    pub network: String,
}

pub async fn require_session(headers: &HeaderMap, st: &AppState) -> AppResult<Session> {
    let token = cookie_token(headers)
        .ok_or_else(|| AppError::Unauthorized("wallet session required".into()))?;
    let (address, network) = st
        .db
        .session(token)
        .await?
        .ok_or_else(|| AppError::Unauthorized("wallet session expired".into()))?;
    Ok(Session { address, network })
}

fn cookie_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .map(str::trim)
        .find_map(|p| p.strip_prefix(&format!("{COOKIE}=")))
}

fn verify_signature(address: &str, message: &str, encoded: &str) -> AppResult<()> {
    let public = decode_public_key(address)?;
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| AppError::Unauthorized("invalid signature encoding".into()))?;
    let signature = Signature::from_slice(&sig_bytes)
        .map_err(|_| AppError::Unauthorized("invalid signature".into()))?;
    let key = VerifyingKey::from_bytes(&public)
        .map_err(|_| AppError::Unauthorized("invalid Stellar address".into()))?;
    let digest = Sha256::digest(format!("{SIGNED_MESSAGE_PREFIX}{message}").as_bytes());
    key.verify(&digest, &signature)
        .map_err(|_| AppError::Unauthorized("signature verification failed".into()))
}

fn decode_public_key(address: &str) -> AppResult<[u8; 32]> {
    let raw = data_encoding::BASE32_NOPAD
        .decode(address.to_ascii_uppercase().as_bytes())
        .map_err(|_| AppError::BadRequest("invalid Stellar address".into()))?;
    if raw.len() != 35 || raw[0] != 6 << 3 {
        return Err(AppError::BadRequest("invalid Stellar public key".into()));
    }
    let expected = crc16::State::<crc16::XMODEM>::calculate(&raw[..33]);
    if raw[33] != expected as u8 || raw[34] != (expected >> 8) as u8 {
        return Err(AppError::BadRequest(
            "invalid Stellar public key checksum".into(),
        ));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&raw[1..33]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{decode_public_key, verify_signature, SIGNED_MESSAGE_PREFIX};
    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey};
    use sha2::{Digest, Sha256};
    #[test]
    fn validates_strkey_checksum() {
        assert!(
            decode_public_key("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF").is_ok()
        )
    }

    #[test]
    fn login_signature_is_bound_to_its_distinct_message() {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let mut raw = vec![6 << 3];
        raw.extend_from_slice(signing.verifying_key().as_bytes());
        let checksum = crc16::State::<crc16::XMODEM>::calculate(&raw);
        raw.extend_from_slice(&checksum.to_le_bytes());
        let address = data_encoding::BASE32_NOPAD.encode(&raw);
        let message =
            "Sign in to Stellar Mosaic\nThis signature cannot decrypt your private notes.";
        let digest = Sha256::digest(format!("{SIGNED_MESSAGE_PREFIX}{message}").as_bytes());
        let signature =
            base64::engine::general_purpose::STANDARD.encode(signing.sign(&digest).to_bytes());
        assert!(verify_signature(&address, message, &signature).is_ok());
        assert!(verify_signature(&address, "Stellar Mosaic recovery", &signature).is_err());
    }
}
