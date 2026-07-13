// Reads the user's Claude Code config (`~/.claude`) for importable assets —
// slash commands, subagents, and skills — so the frontend can copy them into a
// fresh vault during onboarding.
//
// Split of responsibility (see lib/claudeImport.ts):
//   • commands / agents are single `.md` files → `read_claude_code` returns
//     their bodies and the frontend writes them via the vault helpers (reusing
//     the seeders' skip-if-exists + tombstone contract).
//   • a skill is a DIRECTORY (`SKILL.md` + companion scripts / references /
//     assets, possibly binary). `read_claude_code` returns only skill NAMES;
//     the frontend decides which to keep, then calls `copy_claude_skill` to
//     copy the whole folder verbatim — the one job Rust does better than the
//     scoped JS fs plugin (out-of-vault source, recursive, binary-safe).
//
// The global `~/.claude/CLAUDE.md` and settings/MCP are intentionally NOT
// surfaced: the vault's own librarian identity governs, and settings are
// app-managed. Reads are read-only; the only write is the skill-folder copy.

use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Manager};

/// One importable markdown file: its name (filename stem) and full body.
#[derive(Serialize)]
pub struct ImportedFile {
    pub name: String,
    pub body: String,
}

#[derive(Serialize)]
pub struct ClaudeCodeImport {
    /// `~/.claude/commands/*.md` — name is the filename stem, body verbatim.
    pub commands: Vec<ImportedFile>,
    /// `~/.claude/agents/*.md` — name is the filename stem, body verbatim.
    pub agents: Vec<ImportedFile>,
    /// `~/.claude/skills/<name>/` dir names (those containing a `SKILL.md`).
    /// Bodies are NOT read here — the whole folder is copied by
    /// `copy_claude_skill` once the frontend decides to keep it.
    pub skills: Vec<String>,
}

/// Read every `*.md` directly in `dir` (non-recursive) as {stem, body}, sorted
/// by name. A missing/unreadable dir or an unreadable file is skipped, so a
/// partial config still imports what it can.
fn read_md_files(dir: &Path) -> Vec<ImportedFile> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if let Ok(body) = std::fs::read_to_string(&path) {
                out.push(ImportedFile {
                    name: stem.to_string(),
                    body,
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Names of immediate subdirectories of `dir` that contain a `SKILL.md`, sorted.
fn skill_names(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path.join("SKILL.md").is_file() {
                if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                    out.push(name.to_string());
                }
            }
        }
    }
    out.sort();
    out
}

/// Read-only scan of `~/.claude`. Missing sub-dirs yield empty lists (no error),
/// so a user without Claude Code simply gets `{ [], [], [] }`.
#[tauri::command]
pub async fn read_claude_code(app: AppHandle) -> Result<ClaudeCodeImport, String> {
    let base = claude_base(&app)?;
    Ok(ClaudeCodeImport {
        commands: read_md_files(&base.join("commands")),
        agents: read_md_files(&base.join("agents")),
        skills: skill_names(&base.join("skills")),
    })
}

/// Recursively copy the skill folder `~/.claude/skills/<name>` into `dest_dir`
/// (an absolute path the frontend computes as `<vault>/_system/agent/skills/
/// <name>`), preserving companion files and subdirectories. Overwrites files
/// already at the destination — the frontend only calls this for skills it has
/// decided to (re)import, so `dest_dir` is expected to be absent or stale.
#[tauri::command]
pub async fn copy_claude_skill(
    app: AppHandle,
    name: String,
    dest_dir: String,
) -> Result<(), String> {
    // `name` originates from `read_claude_code` (a real dir name), but guard
    // against traversal defensively before joining it to a filesystem path.
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
    {
        return Err(format!("invalid skill name: {name}"));
    }
    let src = claude_base(&app)?.join("skills").join(&name);
    if !src.is_dir() {
        return Err(format!("skill not found: {name}"));
    }
    copy_dir_all(&src, Path::new(&dest_dir))
        .map_err(|e| format!("copy failed for skill {name}: {e}"))
}

/// `~/.claude`, resolved from the OS home dir.
fn claude_base(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir unavailable: {e}"))?;
    Ok(home.join(".claude"))
}

/// Recursively copy `src` (a directory) into `dst`, creating `dst` and any
/// nested directories. Files are copied verbatim (binary-safe via `fs::copy`).
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A skill folder — SKILL.md plus nested companion files (a script and a
    /// reference, one of them binary) — is copied verbatim into a fresh dest.
    #[test]
    fn copy_dir_all_preserves_nested_and_binary_files() {
        let tmp = std::env::temp_dir().join(format!("claude_import_test_{}", std::process::id()));
        let src = tmp.join("src_skill");
        let dst = tmp.join("dst_skill");
        // Clean slate.
        let _ = std::fs::remove_dir_all(&tmp);

        std::fs::create_dir_all(src.join("scripts")).unwrap();
        std::fs::create_dir_all(src.join("references")).unwrap();
        std::fs::write(src.join("SKILL.md"), "---\nname: demo\n---\nbody").unwrap();
        std::fs::write(src.join("scripts/run.sh"), "#!/bin/sh\necho hi\n").unwrap();
        // Binary companion (non-UTF8 bytes) — must survive fs::copy intact.
        let bytes: [u8; 4] = [0x00, 0xff, 0x10, 0x80];
        std::fs::write(src.join("references/logo.bin"), bytes).unwrap();

        copy_dir_all(&src, &dst).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.join("SKILL.md")).unwrap(),
            "---\nname: demo\n---\nbody"
        );
        assert_eq!(
            std::fs::read_to_string(dst.join("scripts/run.sh")).unwrap(),
            "#!/bin/sh\necho hi\n"
        );
        assert_eq!(std::fs::read(dst.join("references/logo.bin")).unwrap(), bytes);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// `read_md_files` returns {stem, body} for each `.md`, sorted, and skips
    /// non-markdown; `skill_names` lists only dirs that contain a `SKILL.md`.
    #[test]
    fn reads_md_bodies_and_skill_dirs() {
        let tmp = std::env::temp_dir().join(format!("claude_import_read_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let cmds = tmp.join("commands");
        std::fs::create_dir_all(&cmds).unwrap();
        std::fs::write(cmds.join("bugfix.md"), "fix it").unwrap();
        std::fs::write(cmds.join("architect.md"), "design it").unwrap();
        std::fs::write(cmds.join("notes.txt"), "ignored").unwrap();

        let files = read_md_files(&cmds);
        assert_eq!(files.len(), 2);
        // Sorted by name.
        assert_eq!(files[0].name, "architect");
        assert_eq!(files[0].body, "design it");
        assert_eq!(files[1].name, "bugfix");

        let skills_dir = tmp.join("skills");
        std::fs::create_dir_all(skills_dir.join("real/inner")).unwrap();
        std::fs::write(skills_dir.join("real/SKILL.md"), "x").unwrap();
        std::fs::create_dir_all(skills_dir.join("empty")).unwrap(); // no SKILL.md
        assert_eq!(skill_names(&skills_dir), vec!["real".to_string()]);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
