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
/// On macOS the `trash` crate defaults to `DeleteMethod::Finder`, which
/// drives Finder over AppleEvents (`osascript … tell application "Finder"`).
/// Under the hardened runtime of a signed + notarized build that AppleEvent
/// is blocked by the kernel unless the app ships the
/// `com.apple.security.automation.apple-events` entitlement AND the user
/// grants a TCC automation prompt — so delete silently FAILS in the packaged
/// app while working in dev. `DeleteMethod::NsFileManager` uses
/// `-[NSFileManager trashItemAtURL:…]` instead: no AppleEvents, works under
/// hardened runtime with no extra entitlement, still a recoverable Trash move.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn move_to_trash(path: String) -> Result<(), String> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut ctx = trash::TrashContext::default();
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    ctx.delete(&path)
        .map_err(|e| format!("move_to_trash failed: {e}"))
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn move_to_trash(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| format!("move_to_trash failed: {e}"))
}
