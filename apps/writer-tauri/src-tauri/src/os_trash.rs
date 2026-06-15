//! Move a file to the OS trash (macOS Trash / Windows Recycle Bin /
//! Linux trash) via the cross-platform `trash` crate.
//!
//! The fs plugin's `remove()` is a permanent delete; deleting a note in
//! the app should be recoverable from the user's normal Trash instead.
//! Module is named `os_trash` (not `trash`) so `trash::delete` below
//! resolves to the crate, not this module.

/// Send the file at `path` (absolute) to the OS trash. Errors surface as
/// a string the JS caller can log / toast.
#[tauri::command]
pub fn move_to_trash(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| format!("move_to_trash failed: {e}"))
}
