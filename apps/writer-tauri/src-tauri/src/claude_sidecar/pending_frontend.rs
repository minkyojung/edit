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

use super::client::Responder;

struct Slot {
    run_id: String,
    responder: Responder,
}

/// Obligations owed to the sidecar that only the frontend can discharge.
#[derive(Default)]
pub struct PendingFrontend {
    // A host-minted token, not the sidecar's JSON-RPC id. The frontend echoes
    // it back verbatim, and it must stay meaningful across a sidecar restart —
    // the sidecar's id counter restarts from zero and would collide.
    next: AtomicI64,
    slots: Mutex<HashMap<i64, Slot>>,
}

impl PendingFrontend {
    pub fn new() -> Self {
        Self::default()
    }

    /// Parks `responder` and returns the token the frontend must echo back.
    pub async fn park(&self, run_id: impl Into<String>, responder: Responder) -> i64 {
        let token = self.next.fetch_add(1, Ordering::Relaxed);
        self.slots.lock().await.insert(token, Slot { run_id: run_id.into(), responder });
        token
    }

    /// Discharges the obligation. `false` if the token is unknown — already
    /// answered, or released when its run ended. Not an error: the frontend
    /// answering a request the host has given up on is a race, not a bug.
    pub async fn answer(&self, token: i64, result: Value) -> bool {
        match self.slots.lock().await.remove(&token) {
            Some(slot) => {
                slot.responder.ok(result);
                true
            }
            None => false,
        }
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
        let doomed: Vec<i64> = slots
            .iter()
            .filter(|(_, s)| s.run_id == run_id)
            .map(|(t, _)| *t)
            .collect();
        for token in &doomed {
            slots.remove(token);
        }
        doomed.len()
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

        let token = pending.park("run-a", r).await;
        assert!(pending.answer(token, json!({ "results": [] })).await);

        let got = replies(&mut rx);
        assert_eq!(got.len(), 1, "exactly one reply");
        assert_eq!(got[0]["id"], json!(11), "answered on the sidecar's id, not the token");
        assert_eq!(got[0]["result"], json!({ "results": [] }));
    }

    #[tokio::test]
    async fn a_second_answer_is_refused_rather_than_sent() {
        let pending = PendingFrontend::new();
        let (r, mut rx) = responder(11);

        let token = pending.park("run-a", r).await;
        assert!(pending.answer(token, json!(1)).await);
        assert!(!pending.answer(token, json!(2)).await, "the slot is gone");

        // The single frame is guaranteed by `Responder::ok` consuming `self`,
        // not by the map — removing the slot is what makes the second call
        // *say so* rather than silently look like it worked.
        assert_eq!(replies(&mut rx).len(), 1);
    }

    #[tokio::test]
    async fn an_unknown_token_is_refused_not_fatal() {
        let pending = PendingFrontend::new();
        assert!(!pending.answer(404, json!(null)).await);
    }

    #[tokio::test]
    async fn a_finished_run_fails_its_obligation_instead_of_parking_it_forever() {
        let pending = PendingFrontend::new();
        let (r, mut rx) = responder(11);
        pending.park("run-a", r).await;

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
        pending.park("run-a", doomed).await;
        let spared_token = pending.park("run-b", spared).await;

        assert_eq!(pending.release_run("run-a").await, 1);
        assert_eq!(replies(&mut doomed_rx).len(), 1);
        assert!(replies(&mut spared_rx).is_empty(), "run-b is still waiting");

        assert!(pending.answer(spared_token, json!("late but fine")).await);
        assert_eq!(replies(&mut spared_rx)[0]["result"], json!("late but fine"));
    }

    #[tokio::test]
    async fn tokens_are_not_reused_while_a_slot_is_live() {
        let pending = PendingFrontend::new();
        let (a, _rx_a) = responder(11);
        let (b, _rx_b) = responder(22);
        let first = pending.park("run-a", a).await;
        let second = pending.park("run-a", b).await;
        assert_ne!(first, second, "a reused token would answer the wrong request");
    }
}
