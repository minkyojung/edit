// Thin Tauri command wrappers over `db.rs`. The events DB lives in the
// per-device app-data dir (`appdata::events_db_path()`), NOT the vault, so the
// vault stays sync-safe — callers no longer pass a vault path. Errors surface
// as plain strings, matching the rest of the backend.

use crate::appdata;
use crate::events::{db, Entry, EventFilter};

#[tauri::command]
pub fn events_insert(entries: Vec<Entry>) -> Result<usize, String> {
    let mut conn = db::open(&appdata::events_db_path())?;
    db::upsert_events(&mut conn, &entries)
}

#[tauri::command]
pub fn events_query(filter: EventFilter) -> Result<Vec<Entry>, String> {
    let conn = db::open(&appdata::events_db_path())?;
    db::query_events(&conn, &filter)
}

#[tauri::command]
pub fn events_search(query: String, limit: u32) -> Result<Vec<Entry>, String> {
    let conn = db::open(&appdata::events_db_path())?;
    db::search_events(&conn, &query, limit)
}
