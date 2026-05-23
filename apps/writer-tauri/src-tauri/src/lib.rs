mod anthropic;
pub mod claude_sidecar;
mod fetch_url;
mod oauth;
mod secure_storage;

use tauri::{Emitter, Manager};

// proof-server lifecycle removed in Phase 3.D. The app no longer spawns
// a bundled sidecar — every doc operation runs against the local Y.Doc
// + IDB. Removing the spawn eliminates the `[collab] failed to derive
// markdown` log class and shaves ~0.5s off cold boot.

#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    app.exit(0);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
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
            fetch_url::fetch_url,
            anthropic::anthropic_messages_create,
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

            // proof-server spawn removed (Phase 3.D). The app now boots
            // directly into the claude sidecars below — no engine gate,
            // no port-4000 listener, no projection-repair daemon.

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
