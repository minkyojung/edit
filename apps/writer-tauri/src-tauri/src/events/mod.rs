// The events store: a SQLite "common envelope" for external structured
// data (GitHub commits/PRs first, later health/sleep/etc.). It lives
// alongside — never inside — the markdown vault: prose stays in `.md`,
// crisp numbers/events land here (raw-data-timeline-memory-plan §2.3).
//
// This module is storage plumbing only. Fetching, auth, and rendering
// event cards into daily notes are later slices.

pub mod commands;
pub mod db;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The common envelope. The outside is fixed (when/source/kind/summary);
/// `payload` holds the provider's raw response verbatim so future needs
/// aren't blocked. `id` is a stable dedup key (e.g. `github:commit:<sha>`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    /// ISO8601 event time — the spine for ordering/aggregation.
    pub ts: String,
    /// ISO8601 ingest time — kept separate from `ts` for backfill/lag.
    pub ingested_at: String,
    pub source: String,
    pub kind: String,
    pub summary: String,
    #[serde(default)]
    pub entities: Vec<String>,
    #[serde(default)]
    pub refs: Vec<String>,
    pub payload: Value,
}

/// Optional filters for `events_query`. Omitted fields are unconstrained.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventFilter {
    pub from_ts: Option<String>,
    pub to_ts: Option<String>,
    pub source: Option<String>,
    pub kind: Option<String>,
    pub limit: Option<u32>,
}
