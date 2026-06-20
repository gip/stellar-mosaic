//! Persistent contract-event ingestion. RPC retention is no longer part of the request path once
//! a desk has been observed: every raw event is stored idempotently and replayed from SQL.
use crate::AppState;
use std::sync::Arc;

pub async fn run(state: Arc<AppState>) {
    loop {
        if let Err(error) = poll_all(&state).await {
            tracing::warn!(%error,"durable indexer poll failed");
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
}

async fn poll_all(state: &Arc<AppState>) -> crate::error::AppResult<()> {
    for desk in state.db.list_desks().await? {
        let cursor = state.db.chain_cursor(&desk.contract_id).await?;
        let from = state.db.desk_from_ledger(&desk.id).await?;
        let stellar = state.stellar.clone();
        let contract = desk.contract_id.clone();
        let page_cursor = cursor.clone();
        let page = tokio::task::spawn_blocking(move || {
            if let Some(cursor) = page_cursor {
                stellar.events_page(&contract, None, Some(&cursor), 1000)
            } else {
                stellar.events_page(&contract, Some(from.unwrap_or(1)), None, 1000)
            }
        })
        .await
        .map_err(|e| crate::error::AppError::Other(e.into()))??;
        let values: Vec<serde_json::Value> = page
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let next = values
            .last()
            .and_then(|v| v.get("id"))
            .and_then(|v| v.as_str());
        state
            .db
            .persist_chain_page(&desk.contract_id, &values, next)
            .await?;
    }
    Ok(())
}
