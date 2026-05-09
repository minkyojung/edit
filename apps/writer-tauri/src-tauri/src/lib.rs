pub mod claude_sidecar;
mod oauth;
mod secure_storage;

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicI32, Ordering};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

// Holds only the proof-server's process group id, not the Child handle.
// Spawn writes; shutdown reads. An atomic int can't be poisoned the way a
// Mutex can if a panic happens mid-lock, so the cleanup path is always
// reachable. The Child is dropped immediately after spawn —
// std::process::Child::drop is a no-op on Unix, so the OS process keeps
// running and we shoot the whole group via SIGTERM at shutdown.
struct ProofServerPgid(AtomicI32);

// Idempotent: swap(0) means whichever shutdown path fires first does the
// kill, the rest are no-ops. Cmd+Q routes through RunEvent::Exit, the X
// button routes through WindowEvent::Destroyed — both call this so a
// proof-server zombie can't be left holding port 4000 between launches.
fn shutdown_proof_server(app: &tauri::AppHandle) {
    let pgid = app
        .state::<ProofServerPgid>()
        .0
        .swap(0, Ordering::SeqCst);
    if pgid > 0 {
        #[cfg(unix)]
        unsafe {
            libc::kill(-pgid, libc::SIGTERM);
        }
        // Belt-and-suspenders: catches grandchildren that escaped the group.
        kill_port_holders(4000);
        println!("[proof-server] killed at shutdown (pgid={pgid})");
    }
}

#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    app.exit(0);
}

// HTTP-pings the bundled proof-server. The frontend's EngineGate calls
// this on mount and after a Retry to know when the server is reachable.
// Short timeout so failure is obvious during cold start (the gate retries
// itself); longer timeouts would just stall the gate UI.
#[tauri::command]
async fn check_proof_server_health() -> Result<(), String> {
    let resp = reqwest::Client::new()
        .get("http://127.0.0.1:4000/health")
        .timeout(Duration::from_millis(800))
        .send()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("health returned {}", resp.status()));
    }
    Ok(())
}

// Frontend-driven recovery: kill whatever's holding port 4000 and spawn a
// fresh proof-server. Returns once spawn succeeds at the OS level —
// the frontend then resumes health-check polling to confirm it actually
// started serving requests. Spawn-time eprintln in spawn_proof_server
// captures the underlying reason for failures (bun missing, binary
// missing, port stuck, etc.).
#[tauri::command]
fn respawn_proof_server(app: tauri::AppHandle) -> Result<(), String> {
    shutdown_proof_server(&app);
    let workspace_root = find_workspace_root(&app);
    let pgid = spawn_proof_server(&workspace_root)
        .map(|child| child.id() as i32)
        .ok_or_else(|| "spawn returned no pid (see app logs for reason)".to_string())?;
    app.state::<ProofServerPgid>()
        .0
        .store(pgid, Ordering::SeqCst);
    Ok(())
}

/// Hand control of the close decision to the frontend by emitting
/// `app:close-requested`. If the emit itself fails we exit immediately to
/// avoid stranding the user on a window they can't dismiss.
fn request_app_close(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        app.exit(0);
        return;
    };
    if let Err(e) = window.emit("app:close-requested", ()) {
        eprintln!("[app] emit close-requested failed: {e}");
        app.exit(0);
    }
}

fn find_workspace_root(app_handle: &tauri::AppHandle) -> PathBuf {
    let mut dir = app_handle
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    for _ in 0..10 {
        // Anchor on proof-sdk's server entry — that's all we need now that
        // dev runs through `bun` (which is on PATH, no per-workspace install).
        if dir.join("node_modules/proof-sdk/server/index.ts").exists() {
            return dir;
        }
        if let Some(parent) = dir.parent() {
            dir = parent.to_path_buf();
        } else {
            break;
        }
    }
    PathBuf::from(".")
}

#[cfg(debug_assertions)]
fn which_bun() -> Option<PathBuf> {
    let path = std::env::var("PATH").ok()?;
    for dir in path.split(':') {
        let candidate = std::path::Path::new(dir).join("bun");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn kill_port_holders(port: u16) {
    if let Ok(out) = Command::new("lsof").arg(format!("-ti:{port}")).output() {
        let pids = String::from_utf8_lossy(&out.stdout);
        let mut killed = false;
        for pid in pids.lines().filter(|l| !l.is_empty()) {
            let _ = Command::new("kill").arg("-9").arg(pid).status();
            println!("[proof-server] killed leftover pid={pid} on port {port}");
            killed = true;
        }
        // Wait for the OS to release the port before attempting a new bind.
        if killed {
            thread::sleep(Duration::from_millis(300));
        }
    }
}

fn spawn_proof_server(workspace_root: &PathBuf) -> Option<Child> {
    // Defensive: a stale proof-server (from a prior dev/run) holding port
    // 4000 will silently keep our new spawn from binding. Kill any
    // lingering listener before we try.
    kill_port_holders(4000);

    let (program, pre_args, working_dir): (PathBuf, Vec<PathBuf>, PathBuf);

    #[cfg(debug_assertions)]
    {
        // Dev: run the .ts source through bun (so bun:sqlite resolves).
        let server_entry = workspace_root.join("node_modules/proof-sdk/server/index.ts");
        if !server_entry.exists() {
            eprintln!("[proof-server] proof-sdk server entry not found");
            return None;
        }
        let bun = match which_bun() {
            Some(b) => b,
            None => {
                eprintln!("[proof-server] bun not found on PATH; install via https://bun.sh");
                return None;
            }
        };
        program = bun;
        pre_args = vec![PathBuf::from("run"), server_entry];
        working_dir = workspace_root.join("node_modules/proof-sdk");
    }

    #[cfg(not(debug_assertions))]
    {
        // Prod: use the bundled proof-server binary that Tauri ships next to
        // the main exe. No Node, no source files, no node_modules required.
        let exe_dir = match std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        {
            Some(d) => d,
            None => {
                eprintln!("[proof-server] could not resolve current_exe parent");
                return None;
            }
        };
        let binary = exe_dir.join("proof-server");
        if !binary.exists() {
            eprintln!(
                "[proof-server] bundled binary not found at {}",
                binary.display()
            );
            return None;
        }
        program = binary;
        pre_args = vec![];
        // Run from the home directory so the bundled binary doesn't try to
        // write into the read-only .app bundle. The actual DB path is set
        // explicitly via DATABASE_PATH below.
        working_dir = std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/tmp"));
    }

    // Resolve writable paths. Dev keeps the legacy in-repo location; prod
    // tucks them into the user's home dir so the bundled binary doesn't
    // try to write inside the read-only .app. proof-sdk reads both via
    // env vars (DATABASE_PATH, SNAPSHOT_DIR) so we just point them.
    let db_path: PathBuf;
    let snapshot_dir: PathBuf;
    #[cfg(debug_assertions)]
    {
        let proof_sdk_dir = workspace_root.join("node_modules/proof-sdk");
        db_path = proof_sdk_dir.join("proof-share.db");
        snapshot_dir = proof_sdk_dir.join("snapshots");
        let _ = std::fs::create_dir_all(&snapshot_dir);
    }
    #[cfg(not(debug_assertions))]
    {
        let home = std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/tmp"));
        let writer_data = home
            .join("Library/Application Support/com.conductor.writer");
        let _ = std::fs::create_dir_all(&writer_data);
        db_path = writer_data.join("proof-share.db");
        snapshot_dir = writer_data.join("snapshots");
        let _ = std::fs::create_dir_all(&snapshot_dir);
    }

    let mut cmd = Command::new(&program);
    for arg in &pre_args {
        cmd.arg(arg);
    }
    cmd.env("PORT", "4000")
        .env("DATABASE_PATH", &db_path)
        .env("SNAPSHOT_DIR", &snapshot_dir)
        // Allow both the dev Vite origin and the prod Tauri webview origins
        // (which differ between Tauri versions / platforms — list both
        // common forms so we don't have to rebuild when Tauri changes).
        .env(
            "PROOF_CORS_ALLOW_ORIGINS",
            "http://localhost:1420,tauri://localhost,http://tauri.localhost,https://tauri.localhost",
        )
        // Collab WS is multiplexed on the same HTTP port (embedded mode).
        // Without this, the server computes collabWsUrl as port+1 (4001) instead of 4000.
        .env("COLLAB_EMBEDDED_WS", "1")
        .current_dir(&working_dir);
    let _ = workspace_root; // silence unused-warn in prod builds

    // Put child in its own process group so we can kill the whole tree
    // (tsx spawns a Node child; we need both to die together).
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }

    match cmd.spawn() {
        Ok(child) => {
            println!("[proof-server] spawned pid={}", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[proof-server] failed to spawn: {e}");
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ProofServerPgid(AtomicI32::new(0)))
        .manage(oauth::PendingOAuth::default())
        .invoke_handler(tauri::generate_handler![
            oauth::start_claude_oauth,
            oauth::complete_claude_oauth,
            oauth::get_claude_token,
            oauth::get_claude_account,
            oauth::disconnect_claude,
            claude_sidecar::commands::claude_chat_start,
            claude_sidecar::commands::claude_chat_cancel,
            claude_sidecar::commands::claude_title,
            app_quit,
            check_proof_server_health,
            respawn_proof_server,
        ])
        .setup(|app| {
            // Replace the default macOS Quit menu item with one we control.
            // The default item calls NSApplication.terminate: directly, which
            // bypasses Tauri's ExitRequested event — so prevent_exit() never
            // gets a chance to ask for user confirmation. Owning the menu
            // item lets us emit `app:close-requested` instead.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{
                    MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
                };

                // Custom items: emit app:close-requested so the frontend can
                // confirm before actually exiting / closing the window.
                let quit_item = MenuItemBuilder::new("Quit Writer")
                    .id("quit")
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)?;
                let close_window_item = MenuItemBuilder::new("Close Window")
                    .id("close-window")
                    .accelerator("CmdOrCtrl+W")
                    .build(app)?;

                // Writer (app menu)
                let app_submenu = SubmenuBuilder::new(app, "Writer")
                    .item(&PredefinedMenuItem::about(app, None, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::hide(app, None)?)
                    .item(&PredefinedMenuItem::hide_others(app, None)?)
                    .item(&PredefinedMenuItem::show_all(app, None)?)
                    .separator()
                    .item(&quit_item)
                    .build()?;

                // Edit — clipboard + select-all only. Undo/Redo intentionally
                // omitted so ProseMirror's keymap (Cmd+Z / Cmd+Shift+Z) handles
                // them; native NSUndoManager would conflict with the editor's
                // own history stack.
                let edit_submenu = SubmenuBuilder::new(app, "Edit")
                    .item(&PredefinedMenuItem::cut(app, None)?)
                    .item(&PredefinedMenuItem::copy(app, None)?)
                    .item(&PredefinedMenuItem::paste(app, None)?)
                    .item(&PredefinedMenuItem::select_all(app, None)?)
                    .build()?;

                // Window — standard window controls + our custom close.
                let window_submenu = SubmenuBuilder::new(app, "Window")
                    .item(&PredefinedMenuItem::minimize(app, None)?)
                    .item(&PredefinedMenuItem::maximize(app, None)?)
                    .item(&PredefinedMenuItem::fullscreen(app, None)?)
                    .separator()
                    .item(&close_window_item)
                    .build()?;

                let menu = MenuBuilder::new(app)
                    .item(&app_submenu)
                    .item(&edit_submenu)
                    .item(&window_submenu)
                    .build()?;
                app.set_menu(menu)?;

                app.on_menu_event(|app, event| {
                    let id = event.id().as_ref();
                    if id == "quit" || id == "close-window" {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("app:close-requested", ());
                        }
                    }
                });
            }

            let workspace_root = find_workspace_root(app.handle());
            println!("[proof-server] workspace root: {}", workspace_root.display());

            // Capture the spawned child's pid (== pgid because we setsid in
            // pre_exec). The Child handle itself is dropped at end of scope —
            // the OS process keeps running, and shutdown uses pgid to SIGTERM
            // the whole group.
            let pgid = spawn_proof_server(&workspace_root)
                .map(|child| child.id() as i32)
                .unwrap_or(0);
            app.state::<ProofServerPgid>()
                .0
                .store(pgid, Ordering::SeqCst);

            // Spawn the Claude sidecars (chat + title). Run on the Tauri
            // async runtime; if it fails, log and let the app keep running
            // so the user at least sees an actionable error in the chat UI.
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match claude_sidecar::manager::SidecarManager::spawn_all(&app_handle).await {
                    Ok(manager) => {
                        // spawn_all already wraps in Arc.
                        app_handle.manage(manager);
                    }
                    Err(e) => {
                        eprintln!("[sidecar manager] failed to spawn: {e}");
                    }
                }
            });

            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Window-level close (the X button). Defer the actual close
            // decision to the frontend — it confirms when chats are streaming.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    request_app_close(window.app_handle());
                    return;
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    shutdown_proof_server(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match &event {
                tauri::RunEvent::Ready => eprintln!("[run] Ready"),
                tauri::RunEvent::ExitRequested { code, .. } => {
                    eprintln!("[run] ExitRequested code={code:?}")
                }
                tauri::RunEvent::Exit => {
                    eprintln!("[run] Exit");
                    // Cmd+Q / dock quit / programmatic exit route here without
                    // firing WindowEvent::Destroyed, so this is the only
                    // reliable hook for proof-server cleanup on those paths.
                    shutdown_proof_server(app_handle);
                }
                tauri::RunEvent::WindowEvent { label, event, .. } => {
                    if matches!(
                        event,
                        tauri::WindowEvent::CloseRequested { .. }
                            | tauri::WindowEvent::Destroyed
                    ) {
                        eprintln!("[run] WindowEvent label={label} kind={event:?}");
                    }
                }
                _ => {}
            }

            // App-level exit (Cmd+Q via the OS, dock quit, etc.). Same
            // confirm-via-frontend path as the window-level handler above.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                if code.is_some() {
                    eprintln!("[run] honoring programmatic exit");
                    return;
                }
                api.prevent_exit();
                request_app_close(app_handle);
            }
        });
}
