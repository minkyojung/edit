// Process-group teardown for the sidecar client.
//
// Needs no token and makes no network calls — it drives `SidecarClient`
// against a shell fixture that stands in for the sidecar, so it runs on
// every `cargo test`. (The token-gated behavioural tests live in
// sidecar_e2e.rs.)
//
// Two invariants, and they pull against each other, which is the whole
// reason both are pinned here:
//
//   1. Dropping a client must take the whole process group with it. The
//      sidecar's `claude` CLI is a *grandchild*, and `kill_on_drop` only
//      reaps the direct child — so without an explicit `killpg` the CLI
//      reparents to launchd and survives. Every restart leaks one.
//
//   2. `hard_kill` must not look like a crash. The manager treats the exit
//      handler as "the sidecar died, restart it" — so a teardown that fires
//      it would have the manager respawn what we just deliberately killed,
//      and re-killing that respawn feeds the crash-loop counter until it
//      trips the cap. Satisfying (1) naively breaks (2).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use writer_tauri_lib::claude_sidecar::client::{NotificationHandler, SidecarClient};

fn fixture() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/spawns-grandchild.sh")
        .to_string_lossy()
        .into_owned()
}

fn noop_notifications() -> NotificationHandler {
    Arc::new(|_method, _params| {})
}

/// Liveness probe. We are not the grandchild's parent, so it never becomes a
/// zombie on our behalf — signal 0 is a clean "does this pid exist" check.
fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Polls `cond` until it holds or the budget runs out. Returns whether it held.
async fn within(budget: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = std::time::Instant::now() + budget;
    loop {
        if cond() {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Spawns the fixture and returns (client, grandchild pid).
async fn spawn_fixture(
    tag: &str,
    on_exit: Option<writer_tauri_lib::claude_sidecar::client::ExitHandler>,
) -> (SidecarClient, PathBuf, i32) {
    let pidfile = std::env::temp_dir().join(format!("sidecar-gc-{}-{tag}.pid", std::process::id()));
    let _ = std::fs::remove_file(&pidfile);

    let args = vec![fixture(), pidfile.to_string_lossy().into_owned()];
    let client = SidecarClient::spawn(
        &PathBuf::from("/bin/sh"),
        &args,
        &[],
        noop_notifications(),
        None,
        on_exit,
    )
    .await
    .expect("fixture spawns");

    let mut pid = None;
    let got = within(Duration::from_secs(5), || {
        pid = std::fs::read_to_string(&pidfile)
            .ok()
            .and_then(|s| s.trim().parse::<i32>().ok());
        pid.is_some()
    })
    .await;
    assert!(got, "fixture never reported a grandchild pid");

    (client, pidfile, pid.unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dropping_a_client_takes_the_whole_process_group() {
    let (client, pidfile, grandchild) = spawn_fixture("drop", None).await;
    assert!(alive(grandchild), "fixture grandchild should be running");

    // Exactly what a sidecar restart does: swap the Arc and let the old one go.
    drop(client);

    let reaped = within(Duration::from_secs(3), || !alive(grandchild)).await;
    let _ = std::fs::remove_file(&pidfile);
    assert!(
        reaped,
        "grandchild {grandchild} outlived the client — the process group leaked"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hard_kill_does_not_look_like_a_crash() {
    let fired = Arc::new(AtomicBool::new(false));
    let on_exit = {
        let fired = fired.clone();
        Arc::new(move || fired.store(true, Ordering::SeqCst)) as _
    };
    let (client, pidfile, grandchild) = spawn_fixture("hardkill", Some(on_exit)).await;

    client.hard_kill();

    // The group must actually die...
    let reaped = within(Duration::from_secs(3), || !alive(grandchild)).await;
    let _ = std::fs::remove_file(&pidfile);
    assert!(reaped, "hard_kill left grandchild {grandchild} alive");

    // ...without the manager hearing about it as an unexpected exit.
    assert!(
        !fired.load(Ordering::SeqCst),
        "hard_kill fired the exit handler — the manager would respawn what we just killed"
    );
}
