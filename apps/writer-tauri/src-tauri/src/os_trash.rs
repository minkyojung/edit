//! Move a file to the OS trash (macOS Trash / Windows Recycle Bin /
//! Linux trash) via the cross-platform `trash` crate.
//!
//! The fs plugin's `remove()` is a permanent delete; deleting a note in
//! the app should be recoverable from the user's normal Trash instead.
//! Module is named `os_trash` (not `trash`) so `trash::delete` below
//! resolves to the crate, not this module.

/// Send the file at `path` (absolute) to the OS trash. Errors surface as
/// a string the JS caller can log / toast.
///
/// `async` + `spawn_blocking` because a sync `#[tauri::command]` runs on the
/// main thread and `-[NSFileManager trashItemAtURL:]` is synchronous. (That
/// dispatch rule is in the macro itself — `tauri-macros/src/command/wrapper.rs`
/// picks kind `"sync"` for a fn with no `asyncness`, `"async"` otherwise.)
///
/// The bench below says what that costs, and it is not what we assumed. The
/// audit's reason for this change was "2N of these per archive"; measured, a
/// steady-state move is 0.3ms, so an eight-document archive is ~5ms — invisible.
/// What is real is the FIRST move in the process: 271-316ms across runs, Cocoa
/// cold init. So this is not a throughput fix. It is that the first delete of a
/// session froze the window for a third of a second, at the moment the user was
/// watching the file disappear.
///
/// On macOS the `trash` crate defaults to `DeleteMethod::Finder`, which
/// drives Finder over AppleEvents (`osascript … tell application "Finder"`).
/// Under the hardened runtime of a signed + notarized build that AppleEvent
/// is blocked by the kernel unless the app ships the
/// `com.apple.security.automation.apple-events` entitlement AND the user
/// grants a TCC automation prompt — so delete silently FAILS in the packaged
/// app while working in dev. `DeleteMethod::NsFileManager` uses
/// `-[NSFileManager trashItemAtURL:…]` instead: no AppleEvents, works under
/// hardened runtime with no extra entitlement, still a recoverable Trash move.
#[tauri::command]
pub async fn move_to_trash(path: String) -> Result<(), String> {
    // Same Result-flattening shape as updater.rs's install step, the other
    // fallible sync file work this app runs off the runtime.
    match tauri::async_runtime::spawn_blocking(move || trash_blocking(&path)).await {
        Ok(r) => r,
        Err(e) => Err(format!("move_to_trash failed to run: {e}")),
    }
}

#[cfg(target_os = "macos")]
fn trash_blocking(path: &str) -> Result<(), String> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut ctx = trash::TrashContext::default();
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    ctx.delete(path)
        .map_err(|e| format!("move_to_trash failed: {e}"))
}

#[cfg(not(target_os = "macos"))]
fn trash_blocking(path: &str) -> Result<(), String> {
    trash::delete(path).map_err(|e| format!("move_to_trash failed: {e}"))
}

#[cfg(test)]
mod tests {
    /// How long one trash move actually costs. Kept, rather than deleted after
    /// it had answered once, because it is the only thing that would notice the
    /// shape changing: the whole justification for `spawn_blocking` above rests
    /// on "first call ~300ms, the rest 0.3ms", and printing the times IN CALL
    /// ORDER is what distinguishes a cold-init spike from a slow operation. A
    /// median alone would have hidden it.
    ///
    /// Ignored by default: it really moves files to the user's Trash. Run with
    /// `cargo test --lib os_trash -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn measure_one_trash_move() {
        use std::io::Write;
        let dir = std::env::temp_dir().join("writer-trash-bench");
        std::fs::create_dir_all(&dir).unwrap();
        let mut times = Vec::new();
        for i in 0..10 {
            let p = dir.join(format!("bench-{i}.md"));
            let mut f = std::fs::File::create(&p).unwrap();
            f.write_all(b"# bench\n").unwrap();
            drop(f);
            let t0 = std::time::Instant::now();
            super::trash_blocking(&p.to_string_lossy()).unwrap();
            times.push(t0.elapsed().as_secs_f64() * 1000.0);
        }
        let first = times[0];
        println!(
            "trash move, in call order (ms): {}",
            times
                .iter()
                .map(|t| format!("{t:.1}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "first call {:.1}ms (Cocoa cold init), median {:.1}ms → an 8-doc archive costs \
             the first {:.0}ms plus {:.0}ms",
            first,
            times[times.len() / 2],
            first,
            times[times.len() / 2] * 15.0,
        );
    }
}
