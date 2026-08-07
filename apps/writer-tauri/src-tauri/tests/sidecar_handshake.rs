// The `initialize` version assert, which had no test until the contract
// actually moved.
//
// Client and sidecar ship in one app bundle, so a version mismatch is never a
// compatibility spread to negotiate — it means `sidecar-pkg/` is stale and
// `pnpm pack:sidecar` was not re-run. The failure that buys is specific: at
// protocol 2, an old sidecar still emits the `chat/query-notes` notification
// pair, so `query_notes` quietly stops working while every other tool looks
// fine. Refusing at startup converts that into one loud error.
//
// Needs no token and makes no network calls.

use std::path::PathBuf;
use std::sync::Arc;

use writer_tauri_lib::claude_sidecar::client::{
    NotificationHandler, SidecarClient, SidecarError, PROTOCOL_VERSION,
};

fn fixture() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/reports-protocol-version.mjs")
        .to_string_lossy()
        .into_owned()
}

async fn handshake(reports: &str) -> Result<SidecarClient, SidecarError> {
    let noop: NotificationHandler = Arc::new(|_, _| {});
    SidecarClient::spawn_initialized(
        &PathBuf::from("node"),
        &[fixture(), reports.to_string()],
        &[],
        noop,
        None,
        None,
    )
    .await
}

#[tokio::test]
async fn a_matching_version_completes_the_handshake() {
    // Guards the assert itself: a test that only ever saw failures would pass
    // just as happily against a client that rejected everything.
    handshake(&PROTOCOL_VERSION.to_string())
        .await
        .map(|_| ())
        .expect("the version we ship is the version we accept");
}

#[tokio::test]
async fn a_stale_sidecar_is_refused_rather_than_used() {
    let err = handshake("1").await.err().expect("protocol 1 is behind");
    assert!(
        matches!(err, SidecarError::ProtocolMismatch { expected, got }
            if expected == PROTOCOL_VERSION && got == Some(1)),
        "the error has to name both numbers to be actionable, got {err:?}",
    );
}

#[tokio::test]
async fn a_sidecar_too_old_to_report_a_version_is_refused_too() {
    // Absent, not wrong. Serde reads the missing field as None, and an
    // `unwrap_or(PROTOCOL_VERSION)` anywhere on that path would wave it
    // through — which is the whole reason `got` is an Option.
    let err = handshake("omit").await.err().expect("no version is not a pass");
    assert!(
        matches!(err, SidecarError::ProtocolMismatch { got: None, .. }),
        "got {err:?}",
    );
}
