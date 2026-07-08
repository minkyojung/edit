//! Reveal a file in the OS file manager (Finder on macOS), selecting it
//! — the "Reveal in Finder" context-menu action. `open -R` opens the
//! enclosing folder with the file highlighted.

/// Reveal `path` (absolute) in the OS file manager.
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("reveal_in_finder failed: {e}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("reveal_in_finder is only implemented on macOS".into())
    }
}
