//! Canonical browser-paid MosaicBridge deployment and Stellar attachment.

use crate::auth::require_session;
use crate::error::{AppError, AppResult};
use crate::models::Desk;
use crate::AppState;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Command;
use std::sync::Arc;

const BASE_SEPOLIA_CHAIN_ID: u64 = 84_532;

#[derive(Debug, Deserialize)]
struct BytecodeObject {
    object: String,
}

#[derive(Debug, Deserialize)]
struct BridgeArtifact {
    abi: Value,
    bytecode: BytecodeObject,
    #[serde(rename = "deployedBytecode")]
    deployed_bytecode: BytecodeObject,
}

#[derive(Debug, Serialize)]
pub struct DeploymentConfig {
    available: bool,
    chain_id: u64,
    network: &'static str,
    reason: Option<String>,
    abi: Option<Value>,
    bytecode: Option<String>,
}

fn read_artifact(st: &AppState) -> AppResult<BridgeArtifact> {
    let path = st.config.bridge_artifact();
    let bytes = std::fs::read(&path).map_err(|e| {
        AppError::BadRequest(format!(
            "MosaicBridge artifact unavailable at {}: {e}",
            path.display()
        ))
    })?;
    serde_json::from_slice(&bytes).map_err(|e| {
        AppError::BadRequest(format!(
            "invalid MosaicBridge artifact at {}: {e}",
            path.display()
        ))
    })
}

pub async fn deployment_config(State(st): State<Arc<AppState>>) -> Json<DeploymentConfig> {
    let unavailable = |reason: String| DeploymentConfig {
        available: false,
        chain_id: BASE_SEPOLIA_CHAIN_ID,
        network: "base-sepolia",
        reason: Some(reason),
        abi: None,
        bytecode: None,
    };
    let pins_valid = st.config.base_router.len() == 56
        && st.config.base_router.starts_with('C')
        && is_hex_bytes(&st.config.base_image_id, 32)
        && is_hex_bytes(&st.config.base_config_id, 32);
    let response = if st.config.base_rpc.is_none() {
        unavailable("Base proving/deployment RPC is not configured".into())
    } else if !pins_valid {
        unavailable("Base verifier router/image/config pins are invalid".into())
    } else {
        match read_artifact(&st) {
            Ok(artifact) => DeploymentConfig {
                available: true,
                chain_id: BASE_SEPOLIA_CHAIN_ID,
                network: "base-sepolia",
                reason: None,
                abi: Some(artifact.abi),
                bytecode: Some(with_0x(&artifact.bytecode.object)),
            },
            Err(error) => unavailable(error.to_string()),
        }
    };
    Json(response)
}

#[derive(Debug, Deserialize)]
pub struct CompleteDeployment {
    pub tx_hash: String,
    pub bridge_address: String,
}

#[derive(Debug, Deserialize)]
struct Receipt {
    #[serde(rename = "contractAddress")]
    contract_address: Option<String>,
    from: String,
    status: Value,
}

fn cast(cast_bin: &str, rpc: &str, args: &[String]) -> AppResult<String> {
    let output = Command::new(cast_bin)
        .args(args)
        .args(["--rpc-url", rpc])
        .output()
        .map_err(|e| AppError::Other(anyhow::anyhow!("spawn cast: {e}")))?;
    if !output.status.success() {
        return Err(AppError::BadRequest(format!(
            "Base RPC verification failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn with_0x(value: &str) -> String {
    if value.starts_with("0x") {
        value.to_string()
    } else {
        format!("0x{value}")
    }
}

fn normalize_hash(value: &str) -> AppResult<String> {
    let value = value.trim();
    let hex = value.strip_prefix("0x").unwrap_or(value);
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::BadRequest(
            "transaction hash must be 32-byte hex".into(),
        ));
    }
    Ok(format!("0x{}", hex.to_ascii_lowercase()))
}

fn is_hex_bytes(value: &str, bytes: usize) -> bool {
    let hex = value.strip_prefix("0x").unwrap_or(value);
    hex.len() == bytes * 2 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn receipt_succeeded(status: &Value) -> bool {
    matches!(status, Value::String(s) if s == "0x1" || s == "1")
        || matches!(status, Value::Number(n) if n.as_u64() == Some(1))
}

fn address_from_call(value: &str) -> AppResult<String> {
    let trimmed = value.trim().trim_matches('"');
    let hex = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    if hex.len() < 40 {
        return Err(AppError::BadRequest(
            "Base contract returned an invalid address".into(),
        ));
    }
    crate::stellar::normalize_evm_bridge(&hex[hex.len() - 40..])
}

fn verify_deployment(
    st: &AppState,
    tx_hash: &str,
    bridge: &str,
    deployer: &str,
    assets: &[crate::models::BaseAssetMapping],
) -> AppResult<()> {
    let rpc = st
        .config
        .base_rpc
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Base RPC is not configured".into()))?;
    let cast_bin = &st.config.cast_bin;
    let chain_id = cast(cast_bin, rpc, &["chain-id".into()])?
        .parse::<u64>()
        .map_err(|_| AppError::BadRequest("Base RPC returned an invalid chain id".into()))?;
    if chain_id != BASE_SEPOLIA_CHAIN_ID {
        return Err(AppError::BadRequest(format!(
            "Base RPC is on chain {chain_id}, expected {BASE_SEPOLIA_CHAIN_ID}"
        )));
    }

    let receipt_raw = cast(
        cast_bin,
        rpc,
        &["receipt".into(), tx_hash.into(), "--json".into()],
    )?;
    let receipt: Receipt = serde_json::from_str(&receipt_raw)
        .map_err(|e| AppError::BadRequest(format!("cannot parse deployment receipt: {e}")))?;
    if !receipt_succeeded(&receipt.status) {
        return Err(AppError::BadRequest(
            "Base deployment transaction failed".into(),
        ));
    }
    let receipt_bridge = receipt
        .contract_address
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("transaction did not create a contract".into()))?;
    if crate::stellar::normalize_evm_bridge(receipt_bridge)? != bridge
        || crate::stellar::normalize_evm_bridge(&receipt.from)? != deployer
    {
        return Err(AppError::BadRequest(
            "deployment receipt does not match the expected bridge and deployer".into(),
        ));
    }

    let artifact = read_artifact(st)?;
    let actual_code = cast(cast_bin, rpc, &["code".into(), bridge.into()])?;
    if actual_code.trim_start_matches("0x").to_ascii_lowercase()
        != artifact
            .deployed_bytecode
            .object
            .trim_start_matches("0x")
            .to_ascii_lowercase()
    {
        return Err(AppError::BadRequest(
            "deployed contract bytecode is not the canonical MosaicBridge".into(),
        ));
    }

    let owner = cast(
        cast_bin,
        rpc,
        &["call".into(), bridge.into(), "owner()(address)".into()],
    )?;
    if address_from_call(&owner)? != deployer {
        return Err(AppError::BadRequest(
            "MosaicBridge owner does not match the deployer".into(),
        ));
    }
    for asset in assets {
        let token = cast(
            cast_bin,
            rpc,
            &[
                "call".into(),
                bridge.into(),
                "assetToken(uint32)(address)".into(),
                asset.asset_id.to_string(),
            ],
        )?;
        if address_from_call(&token)? != crate::stellar::normalize_evm_bridge(&asset.token)? {
            return Err(AppError::BadRequest(format!(
                "MosaicBridge asset {} does not match the desk catalog",
                asset.asset_id
            )));
        }
    }
    Ok(())
}

pub async fn complete_deployment(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<CompleteDeployment>,
) -> AppResult<Json<Desk>> {
    let session = require_session(&headers, &st).await?;
    let creator = st.db.desk_creator(&id).await?;
    if creator.as_deref() != Some(session.address.as_str()) {
        return Err(AppError::Unauthorized(
            "only the desk creator can attach its Base bridge".into(),
        ));
    }
    let deployment = st.db.get_base_deployment(&id).await?.ok_or_else(|| {
        AppError::BadRequest("this desk did not request a Base deployment".into())
    })?;
    let bridge = crate::stellar::normalize_evm_bridge(&body.bridge_address)?;
    let tx_hash = normalize_hash(&body.tx_hash)?;
    if let (Some(existing_tx), Some(existing_bridge)) = (
        deployment.tx_hash.as_deref(),
        deployment.bridge_address.as_deref(),
    ) {
        if existing_tx != tx_hash || existing_bridge != bridge {
            return Err(AppError::Conflict(
                "a different Base deployment is already recorded for this desk".into(),
            ));
        }
    }
    st.db
        .update_base_deployment(&id, "verifying", Some(&tx_hash), Some(&bridge), None)
        .await?;

    let verify_state = st.clone();
    let verify_tx = tx_hash.clone();
    let verify_bridge = bridge.clone();
    let verify_deployer = deployment.deployer_address.clone();
    let verify_assets = deployment.assets.clone();
    let verified = tokio::task::spawn_blocking(move || {
        verify_deployment(
            &verify_state,
            &verify_tx,
            &verify_bridge,
            &verify_deployer,
            &verify_assets,
        )
    })
    .await
    .map_err(|e| AppError::Other(anyhow::anyhow!(e)))?;
    if let Err(error) = verified {
        st.db
            .update_base_deployment(&id, "failed", None, None, Some(&error.to_string()))
            .await?;
        return Err(error);
    }

    st.db
        .update_base_deployment(&id, "configuring", None, None, None)
        .await?;
    let desk = st.db.get_desk(&id).await?;
    let source = st
        .db
        .sponsor_secret(&id)
        .await?
        .ok_or_else(|| AppError::BadRequest("desk sponsor key is unavailable".into()))?;
    let existing = st
        .stellar
        .base_bridge_config(&desk.contract_id, &desk.sponsor_pubkey)?;
    if let Some(existing) = existing {
        if crate::stellar::normalize_evm_bridge(&existing.bridge)? != bridge {
            let message = "settlement contract is already configured with a different Base bridge";
            st.db
                .update_base_deployment(&id, "failed", None, None, Some(message))
                .await?;
            return Err(AppError::Conflict(message.into()));
        }
    } else {
        let args = vec![
            "configure_base_bridge".into(),
            "--router".into(),
            st.config.base_router.clone(),
            "--image_id".into(),
            st.config.base_image_id.clone(),
            "--config_id".into(),
            st.config.base_config_id.clone(),
            "--bridge".into(),
            bridge.trim_start_matches("0x").into(),
        ];
        if let Err(error) = st.stellar.invoke_write(&desk.contract_id, &source, &args) {
            st.db
                .update_base_deployment(&id, "failed", None, None, Some(&error.to_string()))
                .await?;
            return Err(error);
        }
    }
    st.db
        .update_base_deployment(&id, "active", None, None, None)
        .await?;
    Ok(Json(st.db.get_desk(&id).await?))
}

#[cfg(test)]
mod tests {
    use super::{address_from_call, normalize_hash, receipt_succeeded};
    use serde_json::json;

    #[test]
    fn validates_hashes_and_cast_addresses() {
        assert!(normalize_hash(&format!("0x{}", "ab".repeat(32))).is_ok());
        assert!(normalize_hash("0x12").is_err());
        assert_eq!(
            address_from_call("0x000000000000000000000000abababababababababababababababababababab")
                .unwrap(),
            "0xabababababababababababababababababababab"
        );
    }

    #[test]
    fn accepts_cast_receipt_success_shapes() {
        assert!(receipt_succeeded(&json!("0x1")));
        assert!(receipt_succeeded(&json!(1)));
        assert!(!receipt_succeeded(&json!("0x0")));
    }
}
