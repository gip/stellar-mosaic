use crate::error::{AppError, AppResult};
use crate::models::{Asset, Desk, Pair};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::any::AnyPoolOptions;
use sqlx::{AnyPool, Row};
use std::path::Path;
use subtle::ConstantTimeEq;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct WalletBackup {
    pub format_version: u32,
    pub generation: u64,
    pub nonce_b64: String,
    pub ciphertext_b64: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Operation {
    pub id: String,
    pub address: String,
    pub network: String,
    pub desk_id: String,
    pub kind: String,
    pub request: Value,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub error: Option<String>,
    pub submitted: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct OperationEvent {
    pub cursor: i64,
    pub operation_id: String,
    pub event_type: String,
    pub state: String,
    pub message: String,
    pub details: Value,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ClientAction {
    pub id: String,
    pub operation_id: String,
    pub kind: String,
    pub payload: Value,
    pub lease_token: String,
    pub lease_expires_at: i64,
}

#[derive(Clone)]
pub struct Db {
    pool: AnyPool,
    postgres: bool,
}

impl Db {
    pub async fn open(database_url: &str) -> AppResult<Self> {
        sqlx::any::install_default_drivers();
        if database_url.starts_with("sqlite://") {
            if let Some(path) = database_url
                .strip_prefix("sqlite://")
                .and_then(|s| s.split('?').next())
            {
                if path != ":memory:" {
                    if let Some(parent) = Path::new(path).parent() {
                        std::fs::create_dir_all(parent).ok();
                    }
                }
            }
        }
        let postgres =
            database_url.starts_with("postgres://") || database_url.starts_with("postgresql://");
        let pool = AnyPoolOptions::new()
            .max_connections(if postgres { 10 } else { 1 })
            .connect(database_url)
            .await?;
        let db = Self { pool, postgres };
        db.migrate().await?;
        Ok(db)
    }

    async fn migrate(&self) -> AppResult<()> {
        let event_pk = if self.postgres {
            "BIGSERIAL PRIMARY KEY"
        } else {
            "INTEGER PRIMARY KEY AUTOINCREMENT"
        };
        let statements = vec![
            "CREATE TABLE IF NOT EXISTS desks (id TEXT PRIMARY KEY, name TEXT NOT NULL, contract_id TEXT NOT NULL, sponsor_pubkey TEXT NOT NULL, sponsor_secret TEXT, from_ledger BIGINT)",
            "CREATE TABLE IF NOT EXISTS assets (desk_id TEXT NOT NULL, asset_id BIGINT NOT NULL, symbol TEXT NOT NULL, token TEXT NOT NULL, decimals BIGINT NOT NULL DEFAULT 7, PRIMARY KEY (desk_id, asset_id))",
            "CREATE TABLE IF NOT EXISTS pairs (desk_id TEXT NOT NULL, pair_id BIGINT NOT NULL, base_asset BIGINT NOT NULL, quote_asset BIGINT NOT NULL, PRIMARY KEY (desk_id, pair_id))",
            "CREATE TABLE IF NOT EXISTS wallet_backups (backup_id TEXT PRIMARY KEY, write_token_hash TEXT NOT NULL, format_version BIGINT NOT NULL, generation BIGINT NOT NULL, nonce_b64 TEXT NOT NULL, ciphertext_b64 TEXT NOT NULL, updated_at BIGINT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS auth_challenges (id TEXT PRIMARY KEY, address TEXT NOT NULL, message TEXT NOT NULL, expires_at BIGINT NOT NULL, used_at BIGINT)",
            "CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, address TEXT NOT NULL, network TEXT NOT NULL, expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, address TEXT NOT NULL, network TEXT NOT NULL, desk_id TEXT NOT NULL, kind TEXT NOT NULL, request_json TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT NOT NULL, submitted BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, error TEXT, UNIQUE(address, network, idempotency_key))",
            "CREATE INDEX IF NOT EXISTS operations_queue_idx ON operations(address, network, status, created_at)",
            "CREATE TABLE IF NOT EXISTS client_actions (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, address TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, attempts BIGINT NOT NULL DEFAULT 0, lease_token_hash TEXT, lease_expires_at BIGINT, result_json TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)",
            "CREATE INDEX IF NOT EXISTS client_actions_claim_idx ON client_actions(address, status, created_at)",
            "CREATE TABLE IF NOT EXISTS chain_cursors (contract_id TEXT PRIMARY KEY, cursor TEXT, updated_at BIGINT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS chain_events (contract_id TEXT NOT NULL, event_id TEXT NOT NULL, ledger BIGINT, tx_hash TEXT, topic TEXT, payload_json TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(contract_id, event_id))",
            "CREATE TABLE IF NOT EXISTS indexed_notes (contract_id TEXT NOT NULL, leaf_index BIGINT NOT NULL, asset_id BIGINT NOT NULL, amount TEXT NOT NULL, owner_tag TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(contract_id, leaf_index), UNIQUE(contract_id, owner_tag))",
            "CREATE TABLE IF NOT EXISTS indexed_fills (contract_id TEXT NOT NULL, event_id TEXT NOT NULL, ledger BIGINT NOT NULL, tx_hash TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(contract_id, event_id))",
        ];
        for statement in statements {
            sqlx::query(statement).execute(&self.pool).await?;
        }
        // Databases created by the first operations preview did not have bounded retry attempts.
        let _ =
            sqlx::query("ALTER TABLE client_actions ADD COLUMN attempts BIGINT NOT NULL DEFAULT 0")
                .execute(&self.pool)
                .await;
        if !self.postgres {
            // The original rusqlite schema stored this digest as a 32-byte BLOB. Normalize it to
            // the portable lowercase hex representation used by both SQL backends.
            let _ = sqlx::query("UPDATE wallet_backups SET write_token_hash=lower(hex(write_token_hash)) WHERE typeof(write_token_hash)='blob'").execute(&self.pool).await;
        }
        let events = format!("CREATE TABLE IF NOT EXISTS operation_events (cursor {event_pk}, operation_id TEXT NOT NULL, address TEXT NOT NULL, event_type TEXT NOT NULL, state TEXT NOT NULL, message TEXT NOT NULL, details_json TEXT NOT NULL, created_at BIGINT NOT NULL)");
        sqlx::query(&events).execute(&self.pool).await?;
        sqlx::query("CREATE INDEX IF NOT EXISTS operation_events_user_idx ON operation_events(address, cursor)")
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn insert_desk(
        &self,
        desk: &Desk,
        sponsor_secret: Option<&str>,
        from_ledger: Option<u64>,
    ) -> AppResult<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO desks (id,name,contract_id,sponsor_pubkey,sponsor_secret,from_ledger) VALUES (?,?,?,?,?,?)")
            .bind(&desk.id).bind(&desk.name).bind(&desk.contract_id).bind(&desk.sponsor_pubkey)
            .bind(sponsor_secret).bind(from_ledger.map(|x| x as i64)).execute(&mut *tx).await?;
        for a in &desk.assets {
            sqlx::query(
                "INSERT INTO assets (desk_id,asset_id,symbol,token,decimals) VALUES (?,?,?,?,?)",
            )
            .bind(&desk.id)
            .bind(a.asset_id as i64)
            .bind(&a.symbol)
            .bind(&a.token)
            .bind(a.decimals as i64)
            .execute(&mut *tx)
            .await?;
        }
        for p in &desk.pairs {
            sqlx::query(
                "INSERT INTO pairs (desk_id,pair_id,base_asset,quote_asset) VALUES (?,?,?,?)",
            )
            .bind(&desk.id)
            .bind(p.pair_id as i64)
            .bind(p.base_asset as i64)
            .bind(p.quote_asset as i64)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn list_desks(&self) -> AppResult<Vec<Desk>> {
        let rows = sqlx::query("SELECT id FROM desks ORDER BY id")
            .fetch_all(&self.pool)
            .await?;
        let mut out = Vec::new();
        for row in rows {
            out.push(self.get_desk(row.try_get::<String, _>(0)?.as_str()).await?);
        }
        Ok(out)
    }

    pub async fn get_desk(&self, id: &str) -> AppResult<Desk> {
        let row = sqlx::query("SELECT id,name,contract_id,sponsor_pubkey FROM desks WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("desk {id}")))?;
        let assets = sqlx::query(
            "SELECT asset_id,symbol,token,decimals FROM assets WHERE desk_id=? ORDER BY asset_id",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|r| {
            Ok(Asset {
                asset_id: r.try_get::<i64, _>(0)? as u32,
                symbol: r.try_get(1)?,
                token: r.try_get(2)?,
                decimals: r.try_get::<i64, _>(3)? as u32,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
        let pairs = sqlx::query(
            "SELECT pair_id,base_asset,quote_asset FROM pairs WHERE desk_id=? ORDER BY pair_id",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|r| {
            Ok(Pair {
                pair_id: r.try_get::<i64, _>(0)? as u32,
                base_asset: r.try_get::<i64, _>(1)? as u32,
                quote_asset: r.try_get::<i64, _>(2)? as u32,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
        Ok(Desk {
            id: row.try_get(0)?,
            name: row.try_get(1)?,
            contract_id: row.try_get(2)?,
            sponsor_pubkey: row.try_get(3)?,
            assets,
            pairs,
        })
    }

    pub async fn desk_from_ledger(&self, id: &str) -> AppResult<Option<u64>> {
        let row = sqlx::query("SELECT from_ledger FROM desks WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("desk {id}")))?;
        Ok(row.try_get::<Option<i64>, _>(0)?.map(|x| x as u64))
    }

    pub async fn sponsor_secret(&self, id: &str) -> AppResult<Option<String>> {
        let row = sqlx::query("SELECT sponsor_secret FROM desks WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("desk {id}")))?;
        Ok(row.try_get(0)?)
    }

    pub async fn get_wallet_backup(&self, backup_id: &str) -> AppResult<WalletBackup> {
        let row = sqlx::query("SELECT format_version,generation,nonce_b64,ciphertext_b64 FROM wallet_backups WHERE backup_id=?")
            .bind(backup_id).fetch_optional(&self.pool).await?.ok_or_else(|| AppError::NotFound("wallet backup".into()))?;
        Ok(WalletBackup {
            format_version: row.try_get::<i64, _>(0)? as u32,
            generation: row.try_get::<i64, _>(1)? as u64,
            nonce_b64: row.try_get(2)?,
            ciphertext_b64: row.try_get(3)?,
        })
    }

    pub async fn put_wallet_backup(
        &self,
        backup_id: &str,
        write_token_hash: &[u8; 32],
        expected_generation: u64,
        format_version: u32,
        nonce_b64: &str,
        ciphertext_b64: &str,
    ) -> AppResult<u64> {
        let hash = hex::encode(write_token_hash);
        let mut tx = self.pool.begin().await?;
        let existing =
            sqlx::query("SELECT write_token_hash,generation FROM wallet_backups WHERE backup_id=?")
                .bind(backup_id)
                .fetch_optional(&mut *tx)
                .await?;
        let next = if let Some(row) = existing {
            let stored: String = row.try_get(0)?;
            let current = row.try_get::<i64, _>(1)? as u64;
            if !bool::from(stored.as_bytes().ct_eq(hash.as_bytes())) {
                return Err(AppError::Unauthorized(
                    "invalid wallet-backup write token".into(),
                ));
            }
            if current != expected_generation {
                return Err(AppError::Conflict(format!(
                    "stale wallet-backup generation; current={current}"
                )));
            }
            let next = current + 1;
            sqlx::query("UPDATE wallet_backups SET format_version=?,generation=?,nonce_b64=?,ciphertext_b64=?,updated_at=? WHERE backup_id=?")
                .bind(format_version as i64).bind(next as i64).bind(nonce_b64).bind(ciphertext_b64).bind(now_ms()).bind(backup_id).execute(&mut *tx).await?;
            next
        } else {
            if expected_generation != 0 {
                return Err(AppError::Conflict(
                    "wallet backup does not exist; expected_generation must be 0".into(),
                ));
            }
            sqlx::query("INSERT INTO wallet_backups (backup_id,write_token_hash,format_version,generation,nonce_b64,ciphertext_b64,updated_at) VALUES (?,?,?,?,?,?,?)")
                .bind(backup_id).bind(hash).bind(format_version as i64).bind(1_i64).bind(nonce_b64).bind(ciphertext_b64).bind(now_ms()).execute(&mut *tx).await?;
            1
        };
        tx.commit().await?;
        Ok(next)
    }

    pub async fn create_challenge(
        &self,
        address: &str,
        message: &str,
        expires_at: i64,
    ) -> AppResult<String> {
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO auth_challenges (id,address,message,expires_at) VALUES (?,?,?,?)")
            .bind(&id)
            .bind(address)
            .bind(message)
            .bind(expires_at)
            .execute(&self.pool)
            .await?;
        Ok(id)
    }

    pub async fn consume_challenge(&self, id: &str) -> AppResult<(String, String)> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT address,message,expires_at,used_at FROM auth_challenges WHERE id=?",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::Unauthorized("invalid login challenge".into()))?;
        if row.try_get::<Option<i64>, _>(3)?.is_some() || row.try_get::<i64, _>(2)? < now_ms() {
            return Err(AppError::Unauthorized(
                "expired or used login challenge".into(),
            ));
        }
        sqlx::query("UPDATE auth_challenges SET used_at=? WHERE id=? AND used_at IS NULL")
            .bind(now_ms())
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok((row.try_get(0)?, row.try_get(1)?))
    }

    pub async fn create_session(
        &self,
        token: &str,
        address: &str,
        network: &str,
        expires_at: i64,
    ) -> AppResult<()> {
        sqlx::query("INSERT INTO auth_sessions (token_hash,address,network,expires_at,created_at) VALUES (?,?,?,?,?)")
            .bind(hash_token(token)).bind(address).bind(network).bind(expires_at).bind(now_ms()).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn session(&self, token: &str) -> AppResult<Option<(String, String)>> {
        let row =
            sqlx::query("SELECT address,network,expires_at FROM auth_sessions WHERE token_hash=?")
                .bind(hash_token(token))
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.and_then(|r| {
            if r.try_get::<i64, _>(2).ok()? >= now_ms() {
                Some((r.try_get(0).ok()?, r.try_get(1).ok()?))
            } else {
                None
            }
        }))
    }

    pub async fn delete_session(&self, token: &str) -> AppResult<()> {
        sqlx::query("DELETE FROM auth_sessions WHERE token_hash=?")
            .bind(hash_token(token))
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn enqueue_operation(
        &self,
        address: &str,
        network: &str,
        desk_id: &str,
        kind: &str,
        request: &Value,
        idempotency_key: &str,
    ) -> AppResult<Operation> {
        if let Some(row) = sqlx::query(
            "SELECT id FROM operations WHERE address=? AND network=? AND idempotency_key=?",
        )
        .bind(address)
        .bind(network)
        .bind(idempotency_key)
        .fetch_optional(&self.pool)
        .await?
        {
            return self
                .get_operation(address, &row.try_get::<String, _>(0)?)
                .await;
        }
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        let request_json = request.to_string();
        sqlx::query("INSERT INTO operations (id,address,network,desk_id,kind,request_json,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
            .bind(&id).bind(address).bind(network).bind(desk_id).bind(kind).bind(request_json).bind("queued").bind(idempotency_key).bind(now).bind(now).execute(&self.pool).await?;
        self.add_event(
            &id,
            address,
            "created",
            "queued",
            "Operation queued",
            serde_json::json!({}),
        )
        .await?;
        self.get_operation(address, &id).await
    }

    pub async fn list_operations(&self, address: &str) -> AppResult<Vec<Operation>> {
        let rows = sqlx::query("SELECT id,address,network,desk_id,kind,request_json,status,created_at,updated_at,error,submitted FROM operations WHERE address=? ORDER BY created_at DESC")
            .bind(address).fetch_all(&self.pool).await?;
        rows.into_iter().map(operation_from_row).collect()
    }

    pub async fn get_operation(&self, address: &str, id: &str) -> AppResult<Operation> {
        let row = sqlx::query("SELECT id,address,network,desk_id,kind,request_json,status,created_at,updated_at,error,submitted FROM operations WHERE id=? AND address=?")
            .bind(id).bind(address).fetch_optional(&self.pool).await?.ok_or_else(|| AppError::NotFound("operation".into()))?;
        operation_from_row(row)
    }

    pub async fn cancel_operation(&self, address: &str, id: &str) -> AppResult<Operation> {
        let op = self.get_operation(address, id).await?;
        if op.submitted {
            return Err(AppError::Conflict(
                "operation was already submitted on-chain".into(),
            ));
        }
        if matches!(op.status.as_str(), "succeeded" | "failed" | "cancelled") {
            return Ok(op);
        }
        sqlx::query("UPDATE operations SET status='cancelled',updated_at=? WHERE id=?")
            .bind(now_ms())
            .bind(id)
            .execute(&self.pool)
            .await?;
        sqlx::query("UPDATE client_actions SET status='cancelled',updated_at=? WHERE operation_id=? AND status!='completed'").bind(now_ms()).bind(id).execute(&self.pool).await?;
        self.add_event(
            id,
            address,
            "cancelled",
            "cancelled",
            "Operation cancelled",
            serde_json::json!({}),
        )
        .await?;
        self.get_operation(address, id).await
    }

    /// Promote one FIFO head per idle wallet into a durable client action. The correlated NOT EXISTS
    /// is the portable SQLite path; PostgreSQL additionally serializes workers with an advisory
    /// transaction lock at deployment level by running this short transaction repeatedly.
    pub async fn promote_queued(&self) -> AppResult<u64> {
        let orphans=sqlx::query("SELECT id,address,kind,request_json FROM operations o WHERE status='waiting_for_client' AND NOT EXISTS (SELECT 1 FROM client_actions a WHERE a.operation_id=o.id) LIMIT 32").fetch_all(&self.pool).await?;
        for r in orphans {
            let action_id = Uuid::new_v4().to_string();
            let now = now_ms();
            sqlx::query("INSERT INTO client_actions (id,operation_id,address,kind,payload_json,status,created_at,updated_at) VALUES (?,?,?,?,?,'pending',?,?) ON CONFLICT(operation_id) DO NOTHING")
                .bind(action_id).bind(r.try_get::<String,_>(0)?).bind(r.try_get::<String,_>(1)?).bind(r.try_get::<String,_>(2)?).bind(r.try_get::<String,_>(3)?).bind(now).bind(now).execute(&self.pool).await?;
        }
        let rows=sqlx::query("SELECT id,address,kind,request_json FROM operations q WHERE status='queued' AND NOT EXISTS (SELECT 1 FROM operations a WHERE a.address=q.address AND a.network=q.network AND a.status IN ('running','waiting_for_client','waiting_for_chain')) AND NOT EXISTS (SELECT 1 FROM operations older WHERE older.address=q.address AND older.network=q.network AND older.status='queued' AND (older.created_at<q.created_at OR (older.created_at=q.created_at AND older.id<q.id))) ORDER BY created_at LIMIT 32")
            .fetch_all(&self.pool).await?;
        let mut count = 0;
        for r in rows {
            let id: String = r.try_get(0)?;
            let address: String = r.try_get(1)?;
            let kind: String = r.try_get(2)?;
            let payload: String = r.try_get(3)?;
            let updated=sqlx::query("UPDATE operations SET status='waiting_for_client',updated_at=? WHERE id=? AND status='queued'").bind(now_ms()).bind(&id).execute(&self.pool).await?.rows_affected();
            if updated == 0 {
                continue;
            }
            let action_id = Uuid::new_v4().to_string();
            let now = now_ms();
            sqlx::query("INSERT INTO client_actions (id,operation_id,address,kind,payload_json,status,created_at,updated_at) VALUES (?,?,?,?,?,'pending',?,?)")
                .bind(&action_id).bind(&id).bind(&address).bind(&kind).bind(payload).bind(now).bind(now).execute(&self.pool).await?;
            self.add_event(
                &id,
                &address,
                "client_action_required",
                "waiting_for_client",
                "Waiting for the private wallet",
                serde_json::json!({"action_id":action_id,"kind":kind}),
            )
            .await?;
            count += 1;
        }
        Ok(count)
    }

    pub async fn claim_action(&self, address: &str) -> AppResult<Option<ClientAction>> {
        let now = now_ms();
        let row=sqlx::query("SELECT c.id,c.operation_id,c.kind,c.payload_json FROM client_actions c JOIN operations o ON o.id=c.operation_id WHERE c.address=? AND o.status!='succeeded' AND (c.status='pending' OR (c.status='leased' AND c.lease_expires_at<?)) ORDER BY c.created_at LIMIT 1")
            .bind(address).bind(now).fetch_optional(&self.pool).await?;
        let Some(r) = row else { return Ok(None) };
        let id: String = r.try_get(0)?;
        let token = Uuid::new_v4().to_string();
        let expires = now + 90_000;
        let changed=sqlx::query("UPDATE client_actions SET status='leased',lease_token_hash=?,lease_expires_at=?,updated_at=? WHERE id=? AND (status='pending' OR lease_expires_at<?)")
            .bind(hash_token(&token)).bind(expires).bind(now).bind(&id).bind(now).execute(&self.pool).await?.rows_affected();
        if changed == 0 {
            return Ok(None);
        }
        Ok(Some(ClientAction {
            id,
            operation_id: r.try_get(1)?,
            kind: r.try_get(2)?,
            payload: serde_json::from_str(&r.try_get::<String, _>(3)?).unwrap_or(Value::Null),
            lease_token: token,
            lease_expires_at: expires,
        }))
    }

    pub async fn validate_action_lease(
        &self,
        address: &str,
        id: &str,
        token: &str,
    ) -> AppResult<String> {
        let row=sqlx::query("SELECT operation_id,lease_token_hash,lease_expires_at,status FROM client_actions WHERE id=? AND address=?")
            .bind(id).bind(address).fetch_optional(&self.pool).await?.ok_or_else(||AppError::Unauthorized("invalid client action".into()))?;
        let expected: Option<String> = row.try_get(1)?;
        if row.try_get::<String, _>(3)? != "leased"
            || row.try_get::<Option<i64>, _>(2)?.unwrap_or(0) < now_ms()
            || expected.as_deref() != Some(hash_token(token).as_str())
        {
            return Err(AppError::Unauthorized("expired client action lease".into()));
        }
        Ok(row.try_get(0)?)
    }

    pub async fn heartbeat_action(&self, address: &str, id: &str, token: &str) -> AppResult<i64> {
        self.validate_action_lease(address, id, token).await?;
        let expires = now_ms() + 90_000;
        sqlx::query("UPDATE client_actions SET lease_expires_at=?,updated_at=? WHERE id=?")
            .bind(expires)
            .bind(now_ms())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(expires)
    }

    pub async fn mark_submitted(&self, address: &str, operation_id: &str) -> AppResult<()> {
        sqlx::query("UPDATE operations SET submitted=1,status='waiting_for_chain',updated_at=? WHERE id=? AND address=?").bind(now_ms()).bind(operation_id).bind(address).execute(&self.pool).await?;
        self.add_event(
            operation_id,
            address,
            "submitted",
            "waiting_for_chain",
            "Transaction submitted",
            serde_json::json!({}),
        )
        .await
    }

    pub async fn finish_from_chain(
        &self,
        address: &str,
        operation_id: &str,
        result: &str,
    ) -> AppResult<()> {
        sqlx::query("UPDATE operations SET submitted=1,status='succeeded',updated_at=? WHERE id=? AND address=?")
            .bind(now_ms()).bind(operation_id).bind(address).execute(&self.pool).await?;
        self.add_event(
            operation_id,
            address,
            "confirmed",
            "succeeded",
            "On-chain transaction confirmed",
            serde_json::json!({"result":result}),
        )
        .await
    }

    pub async fn complete_action(
        &self,
        address: &str,
        id: &str,
        token: &str,
        result: &Value,
    ) -> AppResult<Operation> {
        let op_id = self.validate_action_lease(address, id, token).await?;
        sqlx::query(
            "UPDATE client_actions SET status='completed',result_json=?,updated_at=? WHERE id=?",
        )
        .bind(result.to_string())
        .bind(now_ms())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if self.get_operation(address, &op_id).await?.status != "succeeded" {
            sqlx::query("UPDATE operations SET status='succeeded',updated_at=? WHERE id=?")
                .bind(now_ms())
                .bind(&op_id)
                .execute(&self.pool)
                .await?;
            self.add_event(
                &op_id,
                address,
                "completed",
                "succeeded",
                "Operation completed",
                result.clone(),
            )
            .await?;
        }
        self.get_operation(address, &op_id).await
    }

    pub async fn fail_action(
        &self,
        address: &str,
        id: &str,
        token: &str,
        error: &str,
        retryable: bool,
    ) -> AppResult<Operation> {
        let op_id = self.validate_action_lease(address, id, token).await?;
        if self.get_operation(address, &op_id).await?.status == "succeeded" {
            sqlx::query("UPDATE client_actions SET status='completed',result_json=?,updated_at=? WHERE id=?")
                .bind(serde_json::json!({"local_error":error}).to_string()).bind(now_ms()).bind(id).execute(&self.pool).await?;
            return self.get_operation(address, &op_id).await;
        }
        let attempts = sqlx::query("SELECT attempts FROM client_actions WHERE id=?")
            .bind(id)
            .fetch_one(&self.pool)
            .await?
            .try_get::<i64, _>(0)?
            + 1;
        if retryable && attempts < 5 {
            sqlx::query("UPDATE client_actions SET status='pending',attempts=?,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").bind(attempts).bind(now_ms()).bind(id).execute(&self.pool).await?;
            self.add_event(
                &op_id,
                address,
                "retry",
                "waiting_for_client",
                "Client step will retry",
                serde_json::json!({"error":error}),
            )
            .await?;
        } else {
            sqlx::query("UPDATE client_actions SET status='failed',attempts=?,result_json=?,updated_at=? WHERE id=?").bind(attempts).bind(serde_json::json!({"error":error}).to_string()).bind(now_ms()).bind(id).execute(&self.pool).await?;
            sqlx::query("UPDATE operations SET status='failed',error=?,updated_at=? WHERE id=?")
                .bind(error)
                .bind(now_ms())
                .bind(&op_id)
                .execute(&self.pool)
                .await?;
            self.add_event(
                &op_id,
                address,
                "failed",
                "failed",
                error,
                serde_json::json!({}),
            )
            .await?;
        }
        self.get_operation(address, &op_id).await
    }

    pub async fn events_after(&self, address: &str, after: i64) -> AppResult<Vec<OperationEvent>> {
        let rows=sqlx::query("SELECT cursor,operation_id,event_type,state,message,details_json,created_at FROM operation_events WHERE address=? AND cursor>? ORDER BY cursor LIMIT 200")
            .bind(address).bind(after).fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|r| {
                Ok(OperationEvent {
                    cursor: r.try_get(0)?,
                    operation_id: r.try_get(1)?,
                    event_type: r.try_get(2)?,
                    state: r.try_get(3)?,
                    message: r.try_get(4)?,
                    details: serde_json::from_str(&r.try_get::<String, _>(5)?)
                        .unwrap_or(Value::Null),
                    created_at: r.try_get(6)?,
                })
            })
            .collect()
    }

    pub async fn chain_cursor(&self, contract_id: &str) -> AppResult<Option<String>> {
        let row = sqlx::query("SELECT cursor FROM chain_cursors WHERE contract_id=?")
            .bind(contract_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.and_then(|r| r.try_get::<Option<String>, _>(0).ok().flatten()))
    }

    pub async fn persist_chain_page(
        &self,
        contract_id: &str,
        values: &[Value],
        cursor: Option<&str>,
    ) -> AppResult<()> {
        let mut tx = self.pool.begin().await?;
        for value in values {
            let Some(event_id) = value.get("id").and_then(Value::as_str) else {
                continue;
            };
            let ledger = value
                .get("ledger")
                .or_else(|| value.get("ledgerSequence"))
                .and_then(Value::as_u64)
                .map(|v| v as i64);
            let tx_hash = value
                .get("txHash")
                .or_else(|| value.get("tx_hash"))
                .and_then(Value::as_str);
            let topic = value.get("topic").map(Value::to_string);
            sqlx::query("INSERT INTO chain_events (contract_id,event_id,ledger,tx_hash,topic,payload_json,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(contract_id,event_id) DO NOTHING")
                .bind(contract_id).bind(event_id).bind(ledger).bind(tx_hash).bind(topic).bind(value.to_string()).bind(now_ms()).execute(&mut *tx).await?;
        }
        if let Some(cursor) = cursor {
            sqlx::query("INSERT INTO chain_cursors (contract_id,cursor,updated_at) VALUES (?,?,?) ON CONFLICT(contract_id) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at")
                .bind(contract_id).bind(cursor).bind(now_ms()).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn chain_events(&self, contract_id: &str) -> AppResult<Vec<Value>> {
        let rows = sqlx::query(
            "SELECT payload_json FROM chain_events WHERE contract_id=? ORDER BY ledger,event_id",
        )
        .bind(contract_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .filter_map(|r| r.try_get::<String, _>(0).ok())
            .filter_map(|s| serde_json::from_str(&s).ok())
            .collect())
    }

    async fn add_event(
        &self,
        operation_id: &str,
        address: &str,
        event_type: &str,
        state: &str,
        message: &str,
        details: Value,
    ) -> AppResult<()> {
        sqlx::query("INSERT INTO operation_events (operation_id,address,event_type,state,message,details_json,created_at) VALUES (?,?,?,?,?,?,?)")
            .bind(operation_id).bind(address).bind(event_type).bind(state).bind(message).bind(details.to_string()).bind(now_ms()).execute(&self.pool).await?;
        Ok(())
    }
}

fn operation_from_row(row: sqlx::any::AnyRow) -> AppResult<Operation> {
    Ok(Operation {
        id: row.try_get(0)?,
        address: row.try_get(1)?,
        network: row.try_get(2)?,
        desk_id: row.try_get(3)?,
        kind: row.try_get(4)?,
        request: serde_json::from_str(&row.try_get::<String, _>(5)?).unwrap_or(Value::Null),
        status: row.try_get(6)?,
        created_at: row.try_get(7)?,
        updated_at: row.try_get(8)?,
        error: row.try_get(9)?,
        submitted: row.try_get::<i64, _>(10)? != 0,
    })
}

fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::Db;
    use serde_json::json;

    async fn db() -> Db {
        Db::open("sqlite::memory:").await.unwrap()
    }

    #[tokio::test]
    async fn backup_compare_and_swap_is_preserved() {
        let db = db().await;
        let hash = [7u8; 32];
        assert_eq!(
            db.put_wallet_backup("backup", &hash, 0, 1, "nonce", "ciphertext-long-enough")
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            db.put_wallet_backup("backup", &hash, 1, 1, "nonce2", "ciphertext-next")
                .await
                .unwrap(),
            2
        );
        assert!(db
            .put_wallet_backup("backup", &hash, 1, 1, "nonce3", "stale")
            .await
            .is_err());
        assert_eq!(db.get_wallet_backup("backup").await.unwrap().generation, 2);
    }

    #[tokio::test]
    async fn queue_is_fifo_per_wallet_and_parallel_across_wallets() {
        let db = db().await;
        let a1 = db
            .enqueue_operation(
                "GA",
                "testnet",
                "desk",
                "shield",
                &json!({"kind":"shield","desk_id":"desk"}),
                "a1",
            )
            .await
            .unwrap();
        let a2 = db
            .enqueue_operation(
                "GA",
                "testnet",
                "desk",
                "shield",
                &json!({"kind":"shield","desk_id":"desk"}),
                "a2",
            )
            .await
            .unwrap();
        db.enqueue_operation(
            "GB",
            "testnet",
            "desk",
            "shield",
            &json!({"kind":"shield","desk_id":"desk"}),
            "b1",
        )
        .await
        .unwrap();
        assert_eq!(db.promote_queued().await.unwrap(), 2);
        let action_a = db.claim_action("GA").await.unwrap().unwrap();
        assert_eq!(action_a.operation_id, a1.id);
        assert!(db.claim_action("GA").await.unwrap().is_none());
        assert!(db.claim_action("GB").await.unwrap().is_some());
        db.complete_action("GA", &action_a.id, &action_a.lease_token, &json!({}))
            .await
            .unwrap();
        assert_eq!(db.promote_queued().await.unwrap(), 1);
        assert_eq!(
            db.claim_action("GA").await.unwrap().unwrap().operation_id,
            a2.id
        );
    }

    #[tokio::test]
    async fn idempotency_and_safe_cancellation() {
        let db = db().await;
        let first = db
            .enqueue_operation(
                "GA",
                "testnet",
                "desk",
                "shield",
                &json!({"kind":"shield"}),
                "same",
            )
            .await
            .unwrap();
        let duplicate = db
            .enqueue_operation(
                "GA",
                "testnet",
                "desk",
                "shield",
                &json!({"kind":"shield"}),
                "same",
            )
            .await
            .unwrap();
        assert_eq!(first.id, duplicate.id);
        assert_eq!(
            db.cancel_operation("GA", &first.id).await.unwrap().status,
            "cancelled"
        );
    }

    #[tokio::test]
    async fn login_challenge_is_one_time() {
        let db = db().await;
        let id = db
            .create_challenge("GA", "message", super::now_ms() + 10_000)
            .await
            .unwrap();
        assert_eq!(db.consume_challenge(&id).await.unwrap().1, "message");
        assert!(db.consume_challenge(&id).await.is_err());
    }

    #[tokio::test]
    async fn postgres_conformance_when_configured() {
        let Ok(url) = std::env::var("MOSAIC_TEST_POSTGRES") else {
            return;
        };
        let db = Db::open(&url).await.unwrap();
        let key = format!("pg-{}", uuid::Uuid::new_v4());
        let op = db
            .enqueue_operation(
                "GPOSTGRES",
                "testnet",
                "desk",
                "shield",
                &json!({"kind":"shield"}),
                &key,
            )
            .await
            .unwrap();
        assert_eq!(
            db.get_operation("GPOSTGRES", &op.id).await.unwrap().id,
            op.id
        );
    }
}
