//! Requests the sidecar asked the host, whose answer only the frontend has.
//!
//! `query_notes` asks for notes filtered by status/tags; that catalog lives in
//! the frontend's docs store, not in Rust. So the host cannot answer inline —
//! it has to park the obligation, emit a Tauri event, and reconnect the
//! frontend's reply (which arrives as a separate `#[tauri::command]`) to the
//! `Responder` that has been waiting.
//!
//! This is not a stopgap for the host not knowing its own vault. `chat/
//! permission` asks whether the *user* approves an edit, and no amount of
//! Rust-side vault knowledge answers that. Parking obligations for someone
//! else to fulfil is permanent.
//!
//! What keeps a parked request from waiting forever is ownership, not a timer:
//! dropping a `Responder` answers -32603, so releasing a slot *is* answering
//! it. The two ways a slot is released are `answer` and `release_run`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};

use serde_json::Value;
use tokio::sync::Mutex;

use super::client::{Responder, INVALID_PARAMS};

struct Slot {
    run_id: String,
    responder: Responder,
}

/// Obligations owed to the sidecar that only the frontend can discharge.
///
/// Keyed by whatever the frontend already echoes back. Some requests carry a
/// domain id that is unique and round-trips anyway — `propose_edit`'s
/// `pendingId` is the review card's own identity, threaded through the
/// frontend's per-path queueing before any ack is sent. Minting a second token
/// beside it would mean teaching that path to carry both. Requests with no
/// such id call `mint`.
#[derive(Default)]
pub struct PendingFrontend {
    next: AtomicI64,
    slots: Mutex<HashMap<String, Slot>>,
}

impl PendingFrontend {
    pub fn new() -> Self {
        Self::default()
    }

    /// A key for a request that has no natural one. Namespaced so it cannot
    /// collide with a caller-supplied id.
    pub fn mint(&self) -> String {
        format!("host-{}", self.next.fetch_add(1, Ordering::Relaxed))
    }

    /// Parks `responder` under `key`. A key already in use is refused rather
    /// than overwritten — overwriting would strand the older request forever,
    /// and its caller is a tool call waiting on a verdict.
    ///
    /// The refusal is answered here rather than handed back, so the message
    /// says what happened. Letting the responder fall out of scope would also
    /// answer, but with "handler dropped without answering", which describes a
    /// different bug.
    pub async fn park(&self, run_id: impl Into<String>, key: &str, responder: Responder) -> bool {
        let mut slots = self.slots.lock().await;
        if slots.contains_key(key) {
            responder.err(INVALID_PARAMS, "a request with this id is already pending");
            return false;
        }
        slots.insert(key.to_owned(), Slot { run_id: run_id.into(), responder });
        true
    }

    /// Discharges the obligation. `false` if the token is unknown — already
    /// answered, or released when its run ended. Not an error: the frontend
    /// answering a request the host has given up on is a race, not a bug.
    pub async fn answer(&self, key: &str, result: Value) -> bool {
        match self.slots.lock().await.remove(key) {
            Some(slot) => {
                slot.responder.ok(result);
                true
            }
            None => false,
        }
    }

    /// Releases one slot without answering it successfully. For the caller
    /// that parked it and then could not reach the frontend at all — the
    /// obligation is real either way, so give it back rather than leak it.
    pub async fn release(&self, key: &str) -> bool {
        self.slots.lock().await.remove(key).is_some()
    }

    /// Releases every obligation belonging to a finished or cancelled run.
    /// Each dropped `Responder` answers -32603, so the sidecar's awaiting tool
    /// call fails loudly instead of parking until the process dies.
    ///
    /// Run lifetime is the honest bound here, not a wall clock. The frontend
    /// listener filters by `runId`, so once a run is gone nothing is listening
    /// and no elapsed time makes an answer more likely.
    pub async fn release_run(&self, run_id: &str) -> usize {
        let mut slots = self.slots.lock().await;
        let doomed: Vec<String> = slots
            .iter()
            .filter(|(_, s)| s.run_id == run_id)
            .map(|(k, _)| k.clone())
            .collect();
        for key in &doomed {
            slots.remove(key);
        }
        doomed.len()
    }

    /// Releases everything, for when the peer that asked is gone: a sidecar
    /// crash or restart. Their replies would go to a closed pipe, and without
    /// this the slots would accumulate across every restart.
    pub async fn release_all(&self) -> usize {
        let drained = std::mem::take(&mut *self.slots.lock().await);
        drained.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_sidecar::framing::FrameParser;
    use serde_json::json;
    use tokio::sync::mpsc;

    /// A responder wired to a channel we can read the reply frames off.
    fn responder(id: i64) -> (Responder, mpsc::Receiver<Vec<u8>>) {
        let (tx, rx) = mpsc::channel(16);
        (Responder::new(json!(id), tx), rx)
    }

    /// Drains whatever the responder wrote. Decoded with the real framing
    /// parser, so a reply that is shaped right but framed wrong still fails.
    fn replies(rx: &mut mpsc::Receiver<Vec<u8>>) -> Vec<Value> {
        let mut parser = FrameParser::new();
        while let Ok(frame) = rx.try_recv() {
            parser.push(&frame);
        }
        let mut out = Vec::new();
        while let Some(p) = parser.next_message() {
            out.push(serde_json::from_slice(&p).expect("valid JSON"));
        }
        out
    }

    #[tokio::test]
    async fn the_frontends_answer_reaches_the_parked_request() {
        let pending = PendingFrontend::new();
        let (r, mut rx) = responder(11);

        let key = pending.mint();
        assert!(pending.park("run-a", &key, r).await);
        assert!(pending.answer(&key, json!({ "results": [] })).await);

        let got = replies(&mut rx);
        assert_eq!(got.len(), 1, "exactly one reply");
        assert_eq!(got[0]["id"], json!(11), "answered on the sidecar's id, not the token");
        assert_eq!(got[0]["result"], json!({ "results": [] }));
    }

    #[tokio::test]
    async fn a_second_answer_is_refused_rather_than_sent() {
        let pending = PendingFrontend::new();
        let (r, mut rx) = responder(11);

        let key = pending.mint();
        assert!(pending.park("run-a", &key, r).await);
        assert!(pending.answer(&key, json!(1)).await);
        assert!(!pending.answer(&key, json!(2)).await, "the slot is gone");

        // The single frame is guaranteed by `Responder::ok` consuming `self`,
        // not by the map — removing the slot is what makes the second call
        // *say so* rather than silently look like it worked.
        assert_eq!(replies(&mut rx).len(), 1);
    }

    #[tokio::test]
    async fn an_unknown_token_is_refused_not_fatal() {
        let pending = PendingFrontend::new();
        assert!(!pending.answer("nobody", json!(null)).await);
    }

    #[tokio::test]
    async fn a_finished_run_fails_its_obligation_instead_of_parking_it_forever() {
        let pending = PendingFrontend::new();
        let (r, mut rx) = responder(11);
        assert!(pending.park("run-a", &pending.mint(), r).await);

        assert_eq!(pending.release_run("run-a").await, 1);

        let got = replies(&mut rx);
        assert_eq!(got.len(), 1, "the sidecar must hear something, or its tool call parks");
        assert_eq!(got[0]["error"]["code"], json!(-32603));
    }

    #[tokio::test]
    async fn releasing_one_run_leaves_another_runs_obligation_alone() {
        let pending = PendingFrontend::new();
        let (doomed, mut doomed_rx) = responder(11);
        let (spared, mut spared_rx) = responder(22);
        assert!(pending.park("run-a", &pending.mint(), doomed).await);
        let spared_key = pending.mint();
        assert!(pending.park("run-b", &spared_key, spared).await);

        assert_eq!(pending.release_run("run-a").await, 1);
        assert_eq!(replies(&mut doomed_rx).len(), 1);
        assert!(replies(&mut spared_rx).is_empty(), "run-b is still waiting");

        assert!(pending.answer(&spared_key, json!("late but fine")).await);
        assert_eq!(replies(&mut spared_rx)[0]["result"], json!("late but fine"));
    }

    #[tokio::test]
    async fn a_released_slot_is_answered_not_leaked() {
        let pending = PendingFrontend::new();
        let (r, mut rx) = responder(11);
        let key = pending.mint();
        assert!(pending.park("run-a", &key, r).await);

        assert!(pending.release(&key).await);
        assert_eq!(replies(&mut rx)[0]["error"]["code"], json!(-32603));
        assert!(!pending.release(&key).await, "the slot is gone");
    }

    #[tokio::test]
    async fn a_dead_peer_releases_every_run_at_once() {
        let pending = PendingFrontend::new();
        let (a, mut rx_a) = responder(11);
        let (b, mut rx_b) = responder(22);
        assert!(pending.park("run-a", &pending.mint(), a).await);
        assert!(pending.park("run-b", &pending.mint(), b).await);

        assert_eq!(pending.release_all().await, 2, "runs are not filtered here");
        assert_eq!(replies(&mut rx_a)[0]["error"]["code"], json!(-32603));
        assert_eq!(replies(&mut rx_b)[0]["error"]["code"], json!(-32603));
        assert_eq!(pending.release_all().await, 0);
    }

    #[tokio::test]
    async fn minted_keys_are_not_reused() {
        let pending = PendingFrontend::new();
        assert_ne!(pending.mint(), pending.mint(), "a reused key answers the wrong request");
    }

    #[tokio::test]
    async fn a_duplicate_key_is_refused_rather_than_stranding_the_first() {
        let pending = PendingFrontend::new();
        let (first, mut first_rx) = responder(11);
        let (second, mut second_rx) = responder(22);

        assert!(pending.park("run-a", "same-id", first).await);
        assert!(!pending.park("run-a", "same-id", second).await, "the key is taken");
        // The loser is told why, not left to the drop guard's generic message.
        assert_eq!(replies(&mut second_rx)[0]["error"]["code"], json!(-32602));

        assert!(pending.answer("same-id", json!("intact")).await, "the first is still parked");
        assert_eq!(replies(&mut first_rx)[0]["result"], json!("intact"));
    }
}
