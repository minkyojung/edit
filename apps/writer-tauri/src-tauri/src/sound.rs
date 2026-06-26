//! Preview a macOS system sound — used by Settings → Appearance so the user can
//! hear the completion-notification sound before choosing it. Plays the named
//! sound from /System/Library/Sounds via `afplay`. The name is whitelisted, so
//! the only thing this can ever play is one of the known system sounds (no
//! arbitrary path can reach the command).

/// Sounds the picker offers — kept in sync with the JS `NotificationSound` type.
const ALLOWED: &[&str] = &["Glass", "Ping", "Pop", "Bottle", "Sosumi"];

/// Play `name` (a macOS system sound) once. No-op for an unknown name.
#[tauri::command]
pub fn play_system_sound(name: String) -> Result<(), String> {
    if !ALLOWED.contains(&name.as_str()) {
        return Ok(()); // silently ignore 'None' / anything off the list
    }
    #[cfg(target_os = "macos")]
    {
        let path = format!("/System/Library/Sounds/{name}.aiff");
        std::process::Command::new("/usr/bin/afplay")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("play_system_sound failed: {e}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}
