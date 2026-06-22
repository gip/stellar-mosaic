use crate::error::{AppError, AppResult};
use crate::models::{CreateDesk, Desk, ImportDesk};
use crate::AppState;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

pub async fn health() -> Json<Value> {
    // Debug, not info: health is polled frequently and would otherwise flood the logs.
    tracing::debug!("health check");
    Json(json!({ "ok": true }))
}

const MAX_BACKUP_CIPHERTEXT: usize = 2 * 1024 * 1024;

#[derive(Serialize)]
pub struct WalletBackupResponse {
    pub format_version: u32,
    pub generation: u64,
    pub nonce_b64: String,
    pub ciphertext_b64: String,
}

#[derive(Deserialize)]
pub struct PutWalletBackup {
    pub expected_generation: u64,
    pub format_version: u32,
    pub nonce_b64: String,
    pub ciphertext_b64: String,
    pub write_token: String,
}

pub async fn get_wallet_backup(
    State(st): State<Arc<AppState>>,
    Path(backup_id): Path<String>,
) -> AppResult<Json<WalletBackupResponse>> {
    validate_capability("backup_id", &backup_id)?;
    let b = st.db.get_wallet_backup(&backup_id).await?;
    Ok(Json(WalletBackupResponse {
        format_version: b.format_version,
        generation: b.generation,
        nonce_b64: b.nonce_b64,
        ciphertext_b64: b.ciphertext_b64,
    }))
}

pub async fn put_wallet_backup(
    State(st): State<Arc<AppState>>,
    Path(backup_id): Path<String>,
    Json(body): Json<PutWalletBackup>,
) -> AppResult<Json<Value>> {
    use base64::Engine;
    use sha2::{Digest, Sha256};

    validate_capability("backup_id", &backup_id)?;
    let token = validate_capability("write_token", &body.write_token)?;
    if body.format_version != 1 {
        return Err(AppError::BadRequest(
            "unsupported backup format_version".into(),
        ));
    }
    let nonce = base64::engine::general_purpose::STANDARD
        .decode(&body.nonce_b64)
        .map_err(|_| AppError::BadRequest("nonce_b64 is not valid base64".into()))?;
    if nonce.len() != 12 {
        return Err(AppError::BadRequest("backup nonce must be 12 bytes".into()));
    }
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(&body.ciphertext_b64)
        .map_err(|_| AppError::BadRequest("ciphertext_b64 is not valid base64".into()))?;
    if ciphertext.len() < 16 || ciphertext.len() > MAX_BACKUP_CIPHERTEXT {
        return Err(AppError::BadRequest(
            "backup ciphertext must be between 16 bytes and 2 MiB".into(),
        ));
    }
    let write_hash: [u8; 32] = Sha256::digest(token).into();
    let generation = st
        .db
        .put_wallet_backup(
            &backup_id,
            &write_hash,
            body.expected_generation,
            body.format_version,
            &body.nonce_b64,
            &body.ciphertext_b64,
        )
        .await?;
    Ok(Json(json!({ "generation": generation })))
}

fn validate_capability(name: &str, value: &str) -> AppResult<Vec<u8>> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AppError::BadRequest(format!("{name} is not valid base64url")))?;
    if bytes.len() != 32 {
        return Err(AppError::BadRequest(format!("{name} must encode 32 bytes")));
    }
    Ok(bytes)
}

#[cfg(test)]
mod wallet_backup_tests {
    use super::validate_capability;

    #[test]
    fn capability_must_be_canonical_32_byte_base64url() {
        assert!(validate_capability("id", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").is_ok());
        assert!(validate_capability("id", "short").is_err());
        assert!(validate_capability("id", "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!").is_err());
    }
}

pub async fn list_desks(State(st): State<Arc<AppState>>) -> AppResult<Json<Vec<Desk>>> {
    tracing::info!("list_desks");
    let desks = st.db.list_desks().await?;
    tracing::info!(count = desks.len(), "list_desks ok");
    Ok(Json(desks))
}

pub async fn get_desk(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> AppResult<Json<Desk>> {
    tracing::info!(desk = %id, "get_desk");
    Ok(Json(st.db.get_desk(&id).await?))
}

/// Import an already-deployed contract as a read-only desk (Phase 1 convenience).
pub async fn import_desk(
    State(st): State<Arc<AppState>>,
    Json(body): Json<ImportDesk>,
) -> AppResult<Json<Desk>> {
    tracing::info!(name = %body.name, contract_id = %body.contract_id, "import_desk");
    if body.contract_id.trim().is_empty() {
        return Err(AppError::BadRequest("contract_id required".into()));
    }
    let desk = Desk {
        id: Uuid::new_v4().to_string(),
        name: body.name,
        contract_id: body.contract_id,
        sponsor_pubkey: body.sponsor_pubkey,
        assets: body.assets,
        pairs: body.pairs,
    };
    st.db.insert_desk(&desk, None, None).await?;
    tracing::info!(desk = %desk.id, contract_id = %desk.contract_id, "import_desk ok");
    Ok(Json(desk))
}

/// Create a new desk: deploy a fresh settlement contract + sponsor account, register assets/pairs.
/// The deploy pipeline makes several blocking testnet calls, so it runs on a blocking thread.
pub async fn create_desk(
    State(st): State<Arc<AppState>>,
    Json(body): Json<CreateDesk>,
) -> AppResult<Json<Desk>> {
    tracing::info!(name = %body.name, assets = body.assets.len(), pairs = body.pairs.len(), "create_desk");
    let st_for_deploy = st.clone();
    let (desk, sponsor_secret, from_ledger) =
        tokio::task::spawn_blocking(move || crate::deploy::create_desk(&st_for_deploy, body))
            .await
            .map_err(|e| AppError::Other(anyhow::anyhow!(e)))??;
    st.db
        .insert_desk(&desk, Some(&sponsor_secret), from_ledger)
        .await?;
    tracing::info!(desk = %desk.id, contract_id = %desk.contract_id, "create_desk ok");
    Ok(Json(desk))
}

pub async fn get_root(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    tracing::info!(desk = %id, "get_root");
    let desk = st.db.get_desk(&id).await?;
    let root = st
        .stellar
        .root(&desk.contract_id, &read_source(&desk, &st))?;
    Ok(Json(json!({ "root": root })))
}

#[derive(Deserialize)]
pub struct BookQuery {
    pub pair: u32,
    pub side: u32,
}

pub async fn get_book(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<BookQuery>,
) -> AppResult<Json<Value>> {
    tracing::info!(desk = %id, pair = q.pair, side = q.side, "get_book");
    let desk = st.db.get_desk(&id).await?;
    let book = st
        .stellar
        .book(&desk.contract_id, &read_source(&desk, &st), q.pair, q.side)?;
    Ok(Json(json!({
        "pair": q.pair,
        "side": q.side,
        "orders": book,
    })))
}

// ---- note discovery + membership paths (indexer) ----

pub async fn get_notes(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    tracing::info!(desk = %id, "get_notes");
    let desk = st.db.get_desk(&id).await?;
    let raw = st.db.chain_events(&desk.contract_id).await?;
    if !raw.is_empty() {
        return Ok(Json(
            json!({ "notes": crate::indexer::notes_from_raw(&raw)? }),
        ));
    }
    let from = st.db.desk_from_ledger(&id).await?;
    let notes = tokio::task::spawn_blocking(move || {
        crate::indexer::notes(&st.stellar, &desk.contract_id, from)
    })
    .await
    .map_err(|e| AppError::Other(anyhow::anyhow!(e)))??;
    Ok(Json(json!({ "notes": notes })))
}

/// Crossing-fill summaries (`filled` events) for the desk. A client matches each `owner_tag` against
/// its own order-output notes to surface a "your order filled" confirmation with the traded amounts.
pub async fn get_fills(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    tracing::info!(desk = %id, "get_fills");
    let desk = st.db.get_desk(&id).await?;
    let raw = st.db.chain_events(&desk.contract_id).await?;
    if !raw.is_empty() {
        return Ok(Json(
            json!({ "fills": crate::indexer::fills_from_raw(&raw) }),
        ));
    }
    let from = st.db.desk_from_ledger(&id).await?;
    let fills = tokio::task::spawn_blocking(move || {
        crate::indexer::fills(&st.stellar, &desk.contract_id, from)
    })
    .await
    .map_err(|e| AppError::Other(anyhow::anyhow!(e)))??;
    Ok(Json(json!({ "fills": fills })))
}

#[derive(Deserialize)]
pub struct ProofQuery {
    pub owner_tag: String,
}

pub async fn get_note_proof(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<ProofQuery>,
) -> AppResult<Json<Value>> {
    tracing::info!(desk = %id, owner_tag = %q.owner_tag, "get_note_proof");
    let desk = st.db.get_desk(&id).await?;
    let raw = st.db.chain_events(&desk.contract_id).await?;
    if !raw.is_empty() {
        return Ok(Json(
            serde_json::to_value(crate::indexer::note_proof_from_raw(&raw, &q.owner_tag)?).unwrap(),
        ));
    }
    let from = st.db.desk_from_ledger(&id).await?;
    let proof = tokio::task::spawn_blocking(move || {
        crate::indexer::note_proof(&st.stellar, &desk.contract_id, from, &q.owner_tag)
    })
    .await
    .map_err(|e| AppError::Other(anyhow::anyhow!(e)))??;
    Ok(Json(serde_json::to_value(proof).unwrap()))
}

// ---- sponsored shield: frontend builds + user-signs the auth entry; sponsor signs envelope ----

#[derive(Deserialize)]
pub struct ShieldSubmit {
    /// Frontend-built transaction XDR: source = sponsor, op auth = user-signed entry, unsigned envelope.
    pub tx_xdr: String,
}

pub async fn shield_submit(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ShieldSubmit>,
) -> AppResult<Json<Value>> {
    let (session, operation_id, _) = crate::operations::authorize_mutation(&headers, &st).await?;
    let op = st.db.get_operation(&session.address, &operation_id).await?;
    if op.desk_id != id || op.kind != "shield" {
        return Err(AppError::Unauthorized(
            "client action does not authorize this shield".into(),
        ));
    }
    let desk = st.db.get_desk(&id).await?;
    validate_shield_xdr(&body.tx_xdr, &desk, &session.address, &op.request)?;
    tracing::info!(desk = %id, xdr_len = body.tx_xdr.len(), "shield_submit: sponsor signing + sending");
    let secret = st.db.sponsor_secret(&id).await?.ok_or_else(|| {
        AppError::BadRequest("desk has no sponsor key (imported, read-only)".into())
    })?;
    let tx_xdr = body.tx_xdr;
    let relay_state = st.clone();
    let out =
        tokio::task::spawn_blocking(move || relay_state.stellar.sign_and_send(&tx_xdr, &secret))
            .await
            .map_err(|e| AppError::Other(anyhow::anyhow!(e)))??;
    st.db
        .finish_from_chain(&session.address, &operation_id, &out)
        .await?;
    tracing::info!(desk = %id, result = %out, "shield_submit ok");
    Ok(Json(json!({ "ok": true, "result": out })))
}

// ---- fully-sponsored relays (no user signature; the ZK proof is the spend authority) ----

#[derive(Deserialize)]
pub struct RelayOrder {
    pub proof_b64: String,
    pub public_inputs_b64: String,
}

pub async fn relay_order(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<RelayOrder>,
) -> AppResult<Json<Value>> {
    relay(
        st,
        headers,
        id,
        "relay_order",
        body.proof_b64,
        body.public_inputs_b64,
        |proof, pi| {
            vec![
                "submit_order".into(),
                "--proof-file-path".into(),
                proof,
                "--public_inputs-file-path".into(),
                pi,
            ]
        },
    )
    .await
}

pub async fn relay_join(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<RelayOrder>,
) -> AppResult<Json<Value>> {
    relay(
        st,
        headers,
        id,
        "relay_join",
        body.proof_b64,
        body.public_inputs_b64,
        |proof, pi| {
            vec![
                "join".into(),
                "--proof-file-path".into(),
                proof,
                "--public_inputs-file-path".into(),
                pi,
            ]
        },
    )
    .await
}

#[derive(Deserialize)]
pub struct RelayUnshield {
    pub to: String,
    pub proof_b64: String,
    pub public_inputs_b64: String,
}

pub async fn relay_unshield(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<RelayUnshield>,
) -> AppResult<Json<Value>> {
    let (session, operation_id, _) = crate::operations::authorize_mutation(&headers, &st).await?;
    let operation = st.db.get_operation(&session.address, &operation_id).await?;
    if operation.request.get("recipient").and_then(Value::as_str) != Some(body.to.as_str()) {
        return Err(AppError::BadRequest(
            "unshield recipient does not match the queued request".into(),
        ));
    }
    let to = body.to;
    relay(
        st,
        headers,
        id,
        "relay_unshield",
        body.proof_b64,
        body.public_inputs_b64,
        move |proof, pi| {
            vec![
                "unshield".into(),
                "--to".into(),
                to,
                "--proof_bytes-file-path".into(),
                proof,
                "--public_inputs-file-path".into(),
                pi,
            ]
        },
    )
    .await
}

#[derive(Deserialize)]
pub struct RelayCancel {
    pub pair_id: u32,
    pub side: u32,
    pub proof_b64: String,
    pub public_inputs_b64: String,
}

pub async fn relay_cancel(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<RelayCancel>,
) -> AppResult<Json<Value>> {
    let (pair, side) = (body.pair_id, body.side);
    relay(
        st,
        headers,
        id,
        "relay_cancel",
        body.proof_b64,
        body.public_inputs_b64,
        move |proof, pi| {
            vec![
                "cancel_order".into(),
                "--pair_id".into(),
                pair.to_string(),
                "--side".into(),
                side.to_string(),
                "--proof-file-path".into(),
                proof,
                "--public_inputs-file-path".into(),
                pi,
            ]
        },
    )
    .await
}

/// Shared relay: decode proof + public inputs, write temp files, submit the call signed by the
/// desk's sponsor (fully sponsored), and clean up.
async fn relay(
    st: Arc<AppState>,
    headers: HeaderMap,
    desk_id: String,
    action: &'static str,
    proof_b64: String,
    pi_b64: String,
    build_args: impl FnOnce(String, String) -> Vec<String> + Send + 'static,
) -> AppResult<Json<Value>> {
    use base64::Engine;
    let (session, operation_id, _) = crate::operations::authorize_mutation(&headers, &st).await?;
    let op = st.db.get_operation(&session.address, &operation_id).await?;
    if op.desk_id != desk_id {
        return Err(AppError::Unauthorized(
            "client action does not authorize this desk".into(),
        ));
    }
    let allowed = matches!(
        (op.kind.as_str(), action),
        ("place_order", "relay_join")
            | ("unshield", "relay_join")
            | ("place_order", "relay_order")
            | ("unshield", "relay_unshield")
            | ("cancel_order", "relay_cancel")
    );
    if !allowed {
        return Err(AppError::Unauthorized(
            "client action does not authorize this relay".into(),
        ));
    }
    tracing::info!(desk = %desk_id, proof_len = proof_b64.len(), "{action}: fully-sponsored relay");
    let secret = st.db.sponsor_secret(&desk_id).await?.ok_or_else(|| {
        AppError::BadRequest("desk has no sponsor key (imported, read-only)".into())
    })?;
    let desk = st.db.get_desk(&desk_id).await?;
    let b64 = base64::engine::general_purpose::STANDARD;
    let proof = b64
        .decode(proof_b64.trim())
        .map_err(|e| AppError::BadRequest(format!("proof_b64: {e}")))?;
    let pi = b64
        .decode(pi_b64.trim())
        .map_err(|e| AppError::BadRequest(format!("public_inputs_b64: {e}")))?;
    validate_public_inputs(action, &op.request, &pi, &desk)?;

    let relay_state = st.clone();
    let out = tokio::task::spawn_blocking(move || -> AppResult<String> {
        let dir = std::env::temp_dir();
        let stem = Uuid::new_v4().to_string();
        let proof_path = dir.join(format!("{stem}.proof"));
        let pi_path = dir.join(format!("{stem}.pi"));
        std::fs::write(&proof_path, &proof).map_err(|e| AppError::Other(e.into()))?;
        std::fs::write(&pi_path, &pi).map_err(|e| AppError::Other(e.into()))?;
        let args = build_args(
            proof_path.to_string_lossy().into(),
            pi_path.to_string_lossy().into(),
        );
        let res = relay_state
            .stellar
            .invoke_write(&desk.contract_id, &secret, &args);
        let _ = std::fs::remove_file(&proof_path);
        let _ = std::fs::remove_file(&pi_path);
        res
    })
    .await
    .map_err(|e| AppError::Other(anyhow::anyhow!(e)))??;

    tracing::info!(desk = %desk_id, result = %out, "{action} ok");
    if action == "relay_join" {
        st.db
            .mark_submitted(&session.address, &operation_id)
            .await?;
    } else {
        st.db
            .finish_from_chain(&session.address, &operation_id, &out)
            .await?;
    }
    Ok(Json(json!({ "ok": true, "result": out })))
}

fn validate_public_inputs(action: &str, request: &Value, pi: &[u8], desk: &Desk) -> AppResult<()> {
    let field = |index: usize| -> AppResult<u128> {
        let bytes = pi
            .get(index * 32..index * 32 + 32)
            .ok_or_else(|| AppError::BadRequest("public input vector is too short".into()))?;
        if bytes[..16].iter().any(|b| *b != 0) {
            return Err(AppError::BadRequest(
                "numeric public input exceeds u128".into(),
            ));
        }
        Ok(u128::from_be_bytes(bytes[16..].try_into().unwrap()))
    };
    let requested = |name: &str| -> AppResult<u128> {
        request
            .get(name)
            .and_then(Value::as_str)
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| AppError::BadRequest(format!("operation has invalid {name}")))
    };
    match action {
        "relay_order" => {
            let pair_id = request
                .get("pair_id")
                .and_then(Value::as_u64)
                .ok_or_else(|| AppError::BadRequest("operation has invalid pair_id".into()))?
                as u32;
            let pair = desk
                .pairs
                .iter()
                .find(|p| p.pair_id == pair_id)
                .ok_or_else(|| AppError::BadRequest("operation pair is not registered".into()))?;
            let sell = request.get("side").and_then(Value::as_str) == Some("SELL");
            let expected_in = if sell {
                pair.base_asset
            } else {
                pair.quote_asset
            } as u128;
            let expected_out = if sell {
                pair.quote_asset
            } else {
                pair.base_asset
            } as u128;
            if pi.len() != 12 * 32
                || field(0)? != 1
                || field(3)? != expected_in
                || field(4)? != requested("amount_in")?
                || field(5)? != expected_out
                || field(6)? != requested("min_out")?
            {
                return Err(AppError::BadRequest(
                    "order proof public inputs do not match the queued request".into(),
                ));
            }
            let partial = request
                .get("partial_allowed")
                .and_then(Value::as_bool)
                .unwrap_or(false) as u128;
            if field(10)? != partial {
                return Err(AppError::BadRequest(
                    "order partial-fill flag does not match the queued request".into(),
                ));
            }
        }
        "relay_unshield" => {
            if pi.len() != 6 * 32
                || field(0)? != 2
                || field(3)?
                    != request
                        .get("asset_id")
                        .and_then(Value::as_u64)
                        .map(u128::from)
                        .unwrap_or(u128::MAX)
                || field(4)? != requested("amount")?
            {
                return Err(AppError::BadRequest(
                    "unshield proof public inputs do not match the queued request".into(),
                ));
            }
        }
        "relay_cancel" if pi.len() != 4 * 32 || field(0)? != 3 => {
            return Err(AppError::BadRequest("invalid cancel public inputs".into()))
        }
        "relay_join" => {
            let expected_asset = if request.get("kind").and_then(Value::as_str) == Some("unshield")
            {
                request
                    .get("asset_id")
                    .and_then(Value::as_u64)
                    .map(u128::from)
            } else {
                let pair = request
                    .get("pair_id")
                    .and_then(Value::as_u64)
                    .and_then(|id| desk.pairs.iter().find(|pair| pair.pair_id == id as u32));
                pair.map(|pair| {
                    if request.get("side").and_then(Value::as_str) == Some("SELL") {
                        pair.base_asset as u128
                    } else {
                        pair.quote_asset as u128
                    }
                })
            };
            if pi.len() != 9 * 32 || field(0)? != 4 || Some(field(4)?) != expected_asset {
                return Err(AppError::BadRequest("invalid join public inputs".into()));
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_shield_xdr(tx_xdr: &str, desk: &Desk, address: &str, request: &Value) -> AppResult<()> {
    use stellar_xdr::curr::{
        HostFunction, Limits, MuxedAccount, OperationBody, ReadXdr, ScAddress, ScVal,
        TransactionEnvelope,
    };
    let envelope = TransactionEnvelope::from_xdr_base64(tx_xdr, Limits::none())
        .map_err(|_| AppError::BadRequest("invalid shield transaction XDR".into()))?;
    let tx = match envelope {
        TransactionEnvelope::Tx(v) => v.tx,
        _ => {
            return Err(AppError::BadRequest(
                "shield must use a v1 transaction envelope".into(),
            ))
        }
    };
    let sponsor = decode_strkey_payload(&desk.sponsor_pubkey, 6 << 3)?;
    if !matches!(&tx.source_account, MuxedAccount::Ed25519(v) if v.0 == sponsor)
        || tx.operations.len() != 1
    {
        return Err(AppError::BadRequest(
            "shield transaction has an unexpected source or operation count".into(),
        ));
    }
    let invoke = match &tx.operations[0].body {
        OperationBody::InvokeHostFunction(v) => v,
        _ => {
            return Err(AppError::BadRequest(
                "shield transaction must invoke the contract".into(),
            ))
        }
    };
    let args = match &invoke.host_function {
        HostFunction::InvokeContract(v) => v,
        _ => {
            return Err(AppError::BadRequest(
                "shield transaction has an unexpected host function".into(),
            ))
        }
    };
    let contract = decode_strkey_payload(&desk.contract_id, 2 << 3)?;
    if !matches!(&args.contract_address, ScAddress::Contract(v) if (v.0).0 == contract)
        || args.function_name.0.to_string() != "shield"
        || args.args.len() != 4
    {
        return Err(AppError::BadRequest(
            "shield transaction targets an unexpected contract invocation".into(),
        ));
    }
    let user = decode_strkey_payload(address, 6 << 3)?;
    let expected_asset = request
        .get("asset_id")
        .and_then(Value::as_u64)
        .unwrap_or(u64::MAX) as u32;
    let expected_amount = request
        .get("amount")
        .and_then(Value::as_str)
        .and_then(|v| v.parse::<i128>().ok())
        .ok_or_else(|| AppError::BadRequest("invalid shield amount".into()))?;
    let actual_amount = match &args.args[2] {
        ScVal::I128(v) => ((v.hi as i128) << 64) | v.lo as i128,
        _ => i128::MIN,
    };
    if !matches!(&args.args[0], ScVal::Address(ScAddress::Account(stellar_xdr::curr::AccountId(stellar_xdr::curr::PublicKey::PublicKeyTypeEd25519(v)))) if v.0 == user)
        || !matches!(&args.args[1], ScVal::U32(v) if *v == expected_asset)
        || actual_amount != expected_amount
    {
        return Err(AppError::BadRequest(
            "shield transaction arguments do not match the queued request".into(),
        ));
    }
    Ok(())
}

fn decode_strkey_payload(value: &str, version: u8) -> AppResult<[u8; 32]> {
    let raw = data_encoding::BASE32_NOPAD
        .decode(value.to_ascii_uppercase().as_bytes())
        .map_err(|_| AppError::BadRequest("invalid Stellar strkey".into()))?;
    if raw.len() != 35 || raw[0] != version {
        return Err(AppError::BadRequest(
            "unexpected Stellar strkey type".into(),
        ));
    }
    let expected = crc16::State::<crc16::XMODEM>::calculate(&raw[..33]);
    if raw[33] != expected as u8 || raw[34] != (expected >> 8) as u8 {
        return Err(AppError::BadRequest(
            "invalid Stellar strkey checksum".into(),
        ));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&raw[1..33]);
    Ok(out)
}

// ---- Base->Stellar shield jobs (WS6) ----

/// Enqueue a Base-shield job for `{bridge, deposit_id}`. The server-side worker proves the deposit,
/// waits for finality, attests the block, and mints the note. Idempotent per (desk, bridge, deposit).
pub async fn enqueue_base_shield(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<(axum::http::StatusCode, Json<crate::db::BaseShieldJob>)> {
    // Gated like other desk mutations: enqueuing kicks off backend proving (~minutes of CPU) and a
    // sponsored Stellar tx, so it must not be callable anonymously.
    crate::auth::require_session(&headers, &st).await?;
    st.db.get_desk(&id).await?;
    let bridge = body
        .get("bridge")
        .and_then(Value::as_str)
        .filter(|s| s.len() == 42 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| AppError::BadRequest("bridge must be a 0x EVM address".into()))?;
    let deposit_id = body
        .get("deposit_id")
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::BadRequest("deposit_id required".into()))?;
    tracing::info!(desk = %id, %bridge, deposit_id, "enqueue base-shield");
    let job = st.db.enqueue_base_shield(&id, bridge, deposit_id as i64).await?;
    Ok((axum::http::StatusCode::ACCEPTED, Json(job)))
}

/// List the Base-shield jobs for a desk (status: proving | awaiting_finality | minting | active | failed).
pub async fn list_base_shields(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> AppResult<Json<Vec<crate::db::BaseShieldJob>>> {
    st.db.get_desk(&id).await?;
    Ok(Json(st.db.list_base_shields(&id).await?))
}

/// Source account for read-only simulations: the desk's sponsor, falling back to the configured
/// read identity for imported desks whose sponsor key isn't in the local keystore.
fn read_source(desk: &Desk, st: &AppState) -> String {
    if desk.sponsor_pubkey.starts_with('G') {
        desk.sponsor_pubkey.clone()
    } else {
        st.config.read_identity.clone()
    }
}
