pub mod claude_sidecar;
mod oauth;
mod secure_storage;

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

struct ProofServerHandle(Arc<Mutex<Option<Child>>>);

#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    app.exit(0);
}

fn find_workspace_root(app_handle: &tauri::AppHandle) -> PathBuf {
    let mut dir = app_handle
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    for _ in 0..10 {
        // Require both tsx and proof-sdk to be present — not just any node_modules.
        if dir.join("node_modules/.bin/tsx").exists()
            && dir.join("node_modules/proof-sdk/server/index.ts").exists()
        {
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
    let tsx = workspace_root.join("node_modules/.bin/tsx");
    let server_entry = workspace_root.join("node_modules/proof-sdk/server/index.ts");

    if !tsx.exists() || !server_entry.exists() {
        eprintln!("[proof-server] tsx or server entry not found");
        return None;
    }

    // Defensive: prior dev sessions can leave a tsx process bound to port 4000.
    // Without this, the new spawn silently fails (port in use) and the stale
    // server keeps responding — including with stale CORS config.
    kill_port_holders(4000);

    let mut cmd = Command::new(&tsx);
    cmd.arg(&server_entry)
        .env("PORT", "4000")
        .env("PROOF_CORS_ALLOW_ORIGINS", "http://localhost:1420")
        // Collab WS is multiplexed on the same HTTP port (embedded mode).
        // Without this, the server computes collabWsUrl as port+1 (4001) instead of 4000.
        .env("COLLAB_EMBEDDED_WS", "1")
        .current_dir(workspace_root.join("node_modules/proof-sdk"));

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
        .manage(ProofServerHandle(Arc::new(Mutex::new(None))))
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

            let child = spawn_proof_server(&workspace_root);
            let state = app.state::<ProofServerHandle>();
            *state.0.lock().unwrap() = child;

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
            // Intercept the user's quit attempt and let the frontend decide
            // whether to confirm (when a chat is streaming) or proceed.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    if let Err(e) = window.emit("app:close-requested", ()) {
                        eprintln!("[app] emit close-requested failed: {e}");
                        // If we can't even emit, don't strand the user — just exit.
                        window.app_handle().exit(0);
                    }
                    return;
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    // Clone Arc before dropping state borrow
                    let child_holder = {
                        let app = window.app_handle();
                        let state = app.state::<ProofServerHandle>();
                        Arc::clone(&state.0)
                    };
                    let child = child_holder.lock().unwrap().take();
                    if let Some(mut child) = child {
                        // Kill the whole process group (negative pid)
                        #[cfg(unix)]
                        unsafe {
                            libc::kill(-(child.id() as i32), libc::SIGTERM);
                        }
                        let _ = child.kill();
                        let _ = child.wait();
                        // Belt-and-suspenders: clean up anything still on the port
                        kill_port_holders(4000);
                        println!("[proof-server] killed on window destroy");
                    }
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
                tauri::RunEvent::Exit => eprintln!("[run] Exit"),
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

            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                if code.is_some() {
                    eprintln!("[run] honoring programmatic exit");
                    return;
                }
                api.prevent_exit();
                if let Some(window) = app_handle.get_webview_window("main") {
                    if let Err(e) = window.emit("app:close-requested", ()) {
                        eprintln!("[app] emit close-requested failed: {e}");
                        app_handle.exit(0);
                    } else {
                        eprintln!("[run] emitted app:close-requested");
                    }
                } else {
                    app_handle.exit(0);
                }
            }
        });
}
