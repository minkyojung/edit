// Pure SQLite logic for the events store — no Tauri types so it can be
// unit-tested directly. `events.db` lives at the vault root (sibling to
// `wiki/`, `daily/`, `.git/`), one file per vault.
//
// Connections are opened per call (SQLite open is sub-millisecond), the
// same stateless shape as `git.rs` taking a vault path on every command.
// `init_schema` is idempotent (`IF NOT EXISTS`) so reopening is free and
// never disturbs existing rows.

use std::path::Path;
use std::time::Duration;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, Row};

use crate::events::{Entry, EventFilter};

/// Open (creating if absent) `<vault>/events.db`, set WAL + a busy
/// timeout so concurrent reads/writes wait rather than error, and ensure
/// the schema exists.
pub fn open(vault_path: &str) -> Result<Connection, String> {
    let db_path = Path::new(vault_path).join("events.db");
    let conn = Connection::open(&db_path).map_err(|e| format!("open events.db: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("set WAL: {e}"))?;
    conn.busy_timeout(Duration::from_millis(5000))
        .map_err(|e| format!("busy_timeout: {e}"))?;
    init_schema(&conn)?;
    Ok(conn)
}

/// Create the three tables + indexes + FTS sync triggers. Idempotent.
fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS events (
            id          TEXT PRIMARY KEY,
            ts          TEXT NOT NULL,
            ingested_at TEXT NOT NULL,
            source      TEXT NOT NULL,
            kind        TEXT NOT NULL,
            summary     TEXT NOT NULL,
            entities    TEXT,
            refs        TEXT,
            payload     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_ts          ON events(ts);
        CREATE INDEX IF NOT EXISTS idx_events_source_kind ON events(source, kind);

        CREATE TABLE IF NOT EXISTS connector_state (
            source     TEXT PRIMARY KEY,
            watermark  TEXT,
            etag       TEXT,
            updated_at TEXT
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS events_fts
            USING fts5(summary, content='events', content_rowid='rowid');

        -- Keep events_fts in sync with events. UPSERT fires the UPDATE
        -- trigger when an existing id is re-inserted, so the old summary
        -- term is removed before the new one is indexed.
        CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
            INSERT INTO events_fts(rowid, summary) VALUES (new.rowid, new.summary);
        END;
        CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
            INSERT INTO events_fts(events_fts, rowid, summary)
                VALUES ('delete', old.rowid, old.summary);
        END;
        CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
            INSERT INTO events_fts(events_fts, rowid, summary)
                VALUES ('delete', old.rowid, old.summary);
            INSERT INTO events_fts(rowid, summary) VALUES (new.rowid, new.summary);
        END;
        "#,
    )
    .map_err(|e| format!("init schema: {e}"))
}

/// UPSERT each entry keyed by `id` — re-importing the same external event
/// overwrites in place rather than duplicating (idempotent connectors).
/// Returns the number of entries processed.
pub fn upsert_events(conn: &mut Connection, entries: &[Entry]) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|e| format!("begin tx: {e}"))?;
    {
        let mut stmt = tx
            .prepare(
                r#"INSERT INTO events
                     (id, ts, ingested_at, source, kind, summary, entities, refs, payload)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                   ON CONFLICT(id) DO UPDATE SET
                     ts=excluded.ts, ingested_at=excluded.ingested_at,
                     source=excluded.source, kind=excluded.kind,
                     summary=excluded.summary, entities=excluded.entities,
                     refs=excluded.refs, payload=excluded.payload"#,
            )
            .map_err(|e| format!("prepare upsert: {e}"))?;
        for e in entries {
            let entities =
                serde_json::to_string(&e.entities).map_err(|err| format!("ser entities: {err}"))?;
            let refs =
                serde_json::to_string(&e.refs).map_err(|err| format!("ser refs: {err}"))?;
            let payload =
                serde_json::to_string(&e.payload).map_err(|err| format!("ser payload: {err}"))?;
            stmt.execute(params![
                e.id, e.ts, e.ingested_at, e.source, e.kind, e.summary, entities, refs, payload
            ])
            .map_err(|err| format!("exec upsert: {err}"))?;
        }
    }
    tx.commit().map_err(|e| format!("commit: {e}"))?;
    Ok(entries.len())
}

/// Query events with optional filters, newest first.
pub fn query_events(conn: &Connection, filter: &EventFilter) -> Result<Vec<Entry>, String> {
    let mut sql = String::from(
        "SELECT id, ts, ingested_at, source, kind, summary, entities, refs, payload FROM events",
    );
    let mut clauses: Vec<&str> = Vec::new();
    let mut args: Vec<SqlValue> = Vec::new();
    if let Some(v) = &filter.from_ts {
        clauses.push("ts >= ?");
        args.push(SqlValue::Text(v.clone()));
    }
    if let Some(v) = &filter.to_ts {
        clauses.push("ts <= ?");
        args.push(SqlValue::Text(v.clone()));
    }
    if let Some(v) = &filter.source {
        clauses.push("source = ?");
        args.push(SqlValue::Text(v.clone()));
    }
    if let Some(v) = &filter.kind {
        clauses.push("kind = ?");
        args.push(SqlValue::Text(v.clone()));
    }
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY ts DESC");
    if let Some(limit) = filter.limit {
        sql.push_str(" LIMIT ?");
        args.push(SqlValue::Integer(limit as i64));
    }

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare query: {e}"))?;
    let rows = stmt
        .query_map(params_from_iter(args), row_to_entry)
        .map_err(|e| format!("query: {e}"))?;
    collect(rows)
}

/// Full-text search over `summary`, newest first.
pub fn search_events(conn: &Connection, query: &str, limit: u32) -> Result<Vec<Entry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.ts, e.ingested_at, e.source, e.kind, e.summary,
                    e.entities, e.refs, e.payload
             FROM events_fts f JOIN events e ON e.rowid = f.rowid
             WHERE events_fts MATCH ?1 ORDER BY e.ts DESC LIMIT ?2",
        )
        .map_err(|e| format!("prepare search: {e}"))?;
    let rows = stmt
        .query_map(params![query, limit], row_to_entry)
        .map_err(|e| format!("search: {e}"))?;
    collect(rows)
}

fn collect<I>(rows: I) -> Result<Vec<Entry>, String>
where
    I: Iterator<Item = rusqlite::Result<Entry>>,
{
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("row: {e}"))?);
    }
    Ok(out)
}

/// Map a row from the canonical column order to an `Entry`. JSON columns
/// fall back to empty/null on parse failure so one malformed row can't
/// poison a whole query.
fn row_to_entry(row: &Row) -> rusqlite::Result<Entry> {
    let entities: String = row.get(6)?;
    let refs: String = row.get(7)?;
    let payload: String = row.get(8)?;
    Ok(Entry {
        id: row.get(0)?,
        ts: row.get(1)?,
        ingested_at: row.get(2)?,
        source: row.get(3)?,
        kind: row.get(4)?,
        summary: row.get(5)?,
        entities: serde_json::from_str(&entities).unwrap_or_default(),
        refs: serde_json::from_str(&refs).unwrap_or_default(),
        payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Entry {
        Entry {
            id: "github:commit:abc123".into(),
            ts: "2026-05-31T14:22:00Z".into(),
            ingested_at: "2026-05-31T22:00:05Z".into(),
            source: "github".into(),
            kind: "commit".into(),
            summary: "fix(review): prevent data loss".into(),
            entities: vec!["manila-v1".into(), "TypeScript".into()],
            refs: vec!["github:pr:8842".into()],
            payload: json!({ "sha": "abc123", "additions": 12 }),
        }
    }

    /// One temp vault dir per test, cleaned at both ends so stale WAL/SHM
    /// files never leak between runs.
    fn temp_vault(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("events_test_{}_{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn roundtrip_query_and_search() {
        let dir = temp_vault("roundtrip");
        let vault = dir.to_str().unwrap();

        let mut conn = open(vault).unwrap();
        assert_eq!(upsert_events(&mut conn, &[sample()]).unwrap(), 1);

        let all = query_events(&conn, &EventFilter::default()).unwrap();
        assert_eq!(all.len(), 1);
        let got = &all[0];
        assert_eq!(got.id, "github:commit:abc123");
        assert_eq!(
            got.entities,
            vec!["manila-v1".to_string(), "TypeScript".to_string()]
        );
        assert_eq!(got.refs, vec!["github:pr:8842".to_string()]);
        assert_eq!(got.payload["additions"], 12);

        let hits = search_events(&conn, "review", 10).unwrap();
        assert_eq!(hits.len(), 1);

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn upsert_is_idempotent_and_reindexes_fts() {
        let dir = temp_vault("idempotent");
        let vault = dir.to_str().unwrap();

        let mut conn = open(vault).unwrap();
        upsert_events(&mut conn, &[sample()]).unwrap();

        // Same id, changed summary — must overwrite, not duplicate.
        let mut updated = sample();
        updated.summary = "fix(review): better message".into();
        upsert_events(&mut conn, &[updated]).unwrap();

        let all = query_events(&conn, &EventFilter::default()).unwrap();
        assert_eq!(all.len(), 1, "upsert must not duplicate by id");
        assert_eq!(all[0].summary, "fix(review): better message");

        // FTS must follow the update: old term gone, new term present.
        assert_eq!(search_events(&conn, "prevent", 10).unwrap().len(), 0);
        assert_eq!(search_events(&conn, "better", 10).unwrap().len(), 1);

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn query_filters_by_source_and_kind() {
        let dir = temp_vault("filters");
        let vault = dir.to_str().unwrap();

        let mut conn = open(vault).unwrap();
        let mut pr = sample();
        pr.id = "github:pr:8842".into();
        pr.kind = "pr_merged".into();
        pr.summary = "merge data structure branch".into();
        upsert_events(&mut conn, &[sample(), pr]).unwrap();

        let commits = query_events(
            &conn,
            &EventFilter {
                kind: Some("commit".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].kind, "commit");

        let github = query_events(
            &conn,
            &EventFilter {
                source: Some("github".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(github.len(), 2);

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
