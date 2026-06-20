use crate::error::AppResult;
use crate::models::{Asset, Desk, Pair};
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;
use subtle::ConstantTimeEq;

#[derive(Clone, Debug)]
pub struct WalletBackup {
    pub format_version: u32,
    pub generation: u64,
    pub nonce_b64: String,
    pub ciphertext_b64: String,
}

/// SQLite-backed desk registry. A single connection guarded by a mutex is plenty for an MVP.
pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        let conn = Connection::open(path).map_err(anyhow_err)?;
        conn.execute_batch(SCHEMA).map_err(anyhow_err)?;
        Ok(Db {
            conn: Mutex::new(conn),
        })
    }

    /// Insert a desk and its assets/pairs. `sponsor_secret` is stored only for desks we deploy.
    /// `from_ledger` is the ledger near which the desk's events begin (for indexer scans).
    pub fn insert_desk(
        &self,
        desk: &Desk,
        sponsor_secret: Option<&str>,
        from_ledger: Option<u64>,
    ) -> AppResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(anyhow_err)?;
        tx.execute(
            "INSERT INTO desks (id, name, contract_id, sponsor_pubkey, sponsor_secret, from_ledger)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                desk.id,
                desk.name,
                desk.contract_id,
                desk.sponsor_pubkey,
                sponsor_secret,
                from_ledger,
            ],
        )
        .map_err(anyhow_err)?;
        for a in &desk.assets {
            tx.execute(
                "INSERT INTO assets (desk_id, asset_id, symbol, token, decimals)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![desk.id, a.asset_id, a.symbol, a.token, a.decimals],
            )
            .map_err(anyhow_err)?;
        }
        for p in &desk.pairs {
            tx.execute(
                "INSERT INTO pairs (desk_id, pair_id, base_asset, quote_asset)
                 VALUES (?1, ?2, ?3, ?4)",
                params![desk.id, p.pair_id, p.base_asset, p.quote_asset],
            )
            .map_err(anyhow_err)?;
        }
        tx.commit().map_err(anyhow_err)?;
        Ok(())
    }

    pub fn list_desks(&self) -> AppResult<Vec<Desk>> {
        let conn = self.conn.lock().unwrap();
        let ids: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT id FROM desks ORDER BY rowid")
                .map_err(anyhow_err)?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(anyhow_err)?;
            rows.collect::<Result<_, _>>().map_err(anyhow_err)?
        };
        ids.iter().map(|id| load_desk(&conn, id)).collect()
    }

    pub fn get_desk(&self, id: &str) -> AppResult<Desk> {
        let conn = self.conn.lock().unwrap();
        load_desk(&conn, id)
    }

    /// Returns the stored `from_ledger` for a desk (None for imported desks).
    pub fn from_ledger(&self, id: &str) -> AppResult<Option<u64>> {
        let conn = self.conn.lock().unwrap();
        let res = conn.query_row(
            "SELECT from_ledger FROM desks WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<i64>>(0),
        );
        match res {
            Ok(v) => Ok(v.map(|x| x as u64)),
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                Err(crate::error::AppError::NotFound(format!("desk {id}")))
            }
            Err(e) => Err(anyhow_err(e).into()),
        }
    }

    /// Returns the sponsor secret (S...) for a desk, if we hold it (deployed desks).
    pub fn sponsor_secret(&self, id: &str) -> AppResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let res = conn.query_row(
            "SELECT sponsor_secret FROM desks WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        );
        match res {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                Err(crate::error::AppError::NotFound(format!("desk {id}")))
            }
            Err(e) => Err(anyhow_err(e).into()),
        }
    }

    pub fn get_wallet_backup(&self, backup_id: &str) -> AppResult<WalletBackup> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT format_version, generation, nonce_b64, ciphertext_b64
             FROM wallet_backups WHERE backup_id = ?1",
            params![backup_id],
            |r| {
                Ok(WalletBackup {
                    format_version: r.get(0)?,
                    generation: r.get::<_, i64>(1)? as u64,
                    nonce_b64: r.get(2)?,
                    ciphertext_b64: r.get(3)?,
                })
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                crate::error::AppError::NotFound("wallet backup".into())
            }
            other => anyhow_err(other).into(),
        })
    }

    /// Create or compare-and-swap an opaque encrypted wallet snapshot. The write token is never
    /// stored; only its SHA-256 digest is retained and compared in constant time.
    pub fn put_wallet_backup(
        &self,
        backup_id: &str,
        write_token_hash: &[u8; 32],
        expected_generation: u64,
        format_version: u32,
        nonce_b64: &str,
        ciphertext_b64: &str,
    ) -> AppResult<u64> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(anyhow_err)?;
        let existing = tx.query_row(
            "SELECT write_token_hash, generation FROM wallet_backups WHERE backup_id = ?1",
            params![backup_id],
            |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, i64>(1)? as u64)),
        );

        let generation = match existing {
            Ok((stored_hash, current)) => {
                if stored_hash.len() != 32
                    || !bool::from(stored_hash.as_slice().ct_eq(write_token_hash.as_slice()))
                {
                    return Err(crate::error::AppError::Unauthorized(
                        "invalid wallet-backup write token".into(),
                    ));
                }
                if current != expected_generation {
                    return Err(crate::error::AppError::Conflict(format!(
                        "stale wallet-backup generation; current={current}"
                    )));
                }
                let next = current + 1;
                tx.execute(
                    "UPDATE wallet_backups SET format_version=?2, generation=?3, nonce_b64=?4,
                     ciphertext_b64=?5, updated_at=strftime('%s','now') WHERE backup_id=?1",
                    params![backup_id, format_version, next as i64, nonce_b64, ciphertext_b64],
                )
                .map_err(anyhow_err)?;
                next
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                if expected_generation != 0 {
                    return Err(crate::error::AppError::Conflict(
                        "wallet backup does not exist; expected_generation must be 0".into(),
                    ));
                }
                tx.execute(
                    "INSERT INTO wallet_backups
                     (backup_id, write_token_hash, format_version, generation, nonce_b64,
                      ciphertext_b64, updated_at) VALUES (?1,?2,?3,1,?4,?5,strftime('%s','now'))",
                    params![backup_id, write_token_hash.as_slice(), format_version, nonce_b64, ciphertext_b64],
                )
                .map_err(anyhow_err)?;
                1
            }
            Err(e) => return Err(anyhow_err(e).into()),
        };
        tx.commit().map_err(anyhow_err)?;
        Ok(generation)
    }
}

fn load_desk(conn: &Connection, id: &str) -> AppResult<Desk> {
    let base = conn.query_row(
        "SELECT id, name, contract_id, sponsor_pubkey FROM desks WHERE id = ?1",
        params![id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        },
    );
    let (id, name, contract_id, sponsor_pubkey) = match base {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return Err(crate::error::AppError::NotFound(format!("desk {id}")))
        }
        Err(e) => return Err(anyhow_err(e).into()),
    };

    let mut astmt = conn
        .prepare("SELECT asset_id, symbol, token, decimals FROM assets WHERE desk_id = ?1 ORDER BY asset_id")
        .map_err(anyhow_err)?;
    let assets = astmt
        .query_map(params![id], |r| {
            Ok(Asset {
                asset_id: r.get(0)?,
                symbol: r.get(1)?,
                token: r.get(2)?,
                decimals: r.get(3)?,
            })
        })
        .map_err(anyhow_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(anyhow_err)?;

    let mut pstmt = conn
        .prepare("SELECT pair_id, base_asset, quote_asset FROM pairs WHERE desk_id = ?1 ORDER BY pair_id")
        .map_err(anyhow_err)?;
    let pairs = pstmt
        .query_map(params![id], |r| {
            Ok(Pair {
                pair_id: r.get(0)?,
                base_asset: r.get(1)?,
                quote_asset: r.get(2)?,
            })
        })
        .map_err(anyhow_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(anyhow_err)?;

    Ok(Desk {
        id,
        name,
        contract_id,
        sponsor_pubkey,
        assets,
        pairs,
    })
}

fn anyhow_err(e: rusqlite::Error) -> anyhow::Error {
    anyhow::anyhow!(e)
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS desks (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    contract_id     TEXT NOT NULL,
    sponsor_pubkey  TEXT NOT NULL,
    sponsor_secret  TEXT,
    from_ledger     INTEGER
);
CREATE TABLE IF NOT EXISTS assets (
    desk_id   TEXT NOT NULL REFERENCES desks(id),
    asset_id  INTEGER NOT NULL,
    symbol    TEXT NOT NULL,
    token     TEXT NOT NULL,
    decimals  INTEGER NOT NULL DEFAULT 7,
    PRIMARY KEY (desk_id, asset_id)
);
CREATE TABLE IF NOT EXISTS pairs (
    desk_id      TEXT NOT NULL REFERENCES desks(id),
    pair_id      INTEGER NOT NULL,
    base_asset   INTEGER NOT NULL,
    quote_asset  INTEGER NOT NULL,
    PRIMARY KEY (desk_id, pair_id)
);
CREATE TABLE IF NOT EXISTS wallet_backups (
    backup_id        TEXT PRIMARY KEY,
    write_token_hash BLOB NOT NULL,
    format_version   INTEGER NOT NULL,
    generation       INTEGER NOT NULL,
    nonce_b64        TEXT NOT NULL,
    ciphertext_b64   TEXT NOT NULL,
    updated_at       INTEGER NOT NULL
);
"#;

#[cfg(test)]
mod tests {
    use super::Db;
    use crate::error::AppError;
    use std::path::Path;

    #[test]
    fn wallet_backup_create_read_update_and_guards() {
        let db = Db::open(Path::new(":memory:")).unwrap();
        let token = [7u8; 32];
        let wrong = [8u8; 32];

        assert!(matches!(
            db.get_wallet_backup("backup"),
            Err(AppError::NotFound(_))
        ));
        assert_eq!(
            db.put_wallet_backup("backup", &token, 0, 1, "nonce-a", "cipher-a")
                .unwrap(),
            1
        );
        let first = db.get_wallet_backup("backup").unwrap();
        assert_eq!(first.generation, 1);
        assert_eq!(first.ciphertext_b64, "cipher-a");

        assert!(matches!(
            db.put_wallet_backup("backup", &wrong, 1, 1, "nonce-x", "cipher-x"),
            Err(AppError::Unauthorized(_))
        ));
        assert!(matches!(
            db.put_wallet_backup("backup", &token, 0, 1, "nonce-x", "cipher-x"),
            Err(AppError::Conflict(_))
        ));
        assert_eq!(
            db.put_wallet_backup("backup", &token, 1, 1, "nonce-b", "cipher-b")
                .unwrap(),
            2
        );
        let second = db.get_wallet_backup("backup").unwrap();
        assert_eq!(second.generation, 2);
        assert_eq!(second.nonce_b64, "nonce-b");
        assert_eq!(second.ciphertext_b64, "cipher-b");
    }
}
