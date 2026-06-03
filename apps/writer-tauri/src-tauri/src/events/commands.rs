// Thin Tauri command wrappers over `db.rs`. Each takes the vault path
// (the frontend resolves it once in `lib/eventsDb.ts`) and surfaces
// errors as plain strings, matching the rest of the backend.

use crate::events::{db, Entry, EventFilter};

#[tauri::command]
pub fn events_insert(vault_path: String, entries: Vec<Entry>) -> Result<usize, String> {
    let mut conn = db::open(&vault_path)?;
    db::upsert_events(&mut conn, &entries)
}

#[tauri::command]
pub fn events_query(vault_path: String, filter: EventFilter) -> Result<Vec<Entry>, String> {
    let conn = db::open(&vault_path)?;
    db::query_events(&conn, &filter)
}

#[tauri::command]
pub fn events_search(
    vault_path: String,
    query: String,
    limit: u32,
) -> Result<Vec<Entry>, String> {
    let conn = db::open(&vault_path)?;
    db::search_events(&conn, &query, limit)
}
