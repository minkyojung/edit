mod appdata;
mod claude_import;
pub mod claude_sidecar;
mod fetch_url;
mod git;
mod google_oauth;
mod models_catalog;
mod oauth;
mod os_trash;
mod reveal;
mod sound;
mod secure_storage;
mod updater;
mod window_chrome;

use tauri::{Emitter, Manager};

// proof-server lifecycle removed in Phase 3.D. The app no longer spawns
// a bundled sidecar — every doc operation runs against the local Y.Doc
// + IDB. Removing the spawn eliminates the `[collab] failed to derive
// markdown` log class and shaves ~0.5s off cold boot.

/// Quit funnel. Every quit route (⌘Q, dock quit, the frontend confirm dialog)
/// ends here, so this is where we tear the sidecars down *before* exiting.
/// `app.exit(0)` ends in `std::process::exit`, which skips `Drop` — so
/// `kill_on_drop` never fires and the Node sidecars (plus their `claude` CLI
/// grandchildren) would be orphaned. Awaiting a graceful shutdown first lets
/// each sidecar reap its CLI child and flush its session (resume stays intact),
/// then we exit cleanly.
#[tauri::command]
async fn app_quit(app: tauri::AppHandle) {
    use claude_sidecar::manager::SidecarManager;
    if let Some(mgr) = app.try_state::<std::sync::Arc<SidecarManager>>() {
        mgr.shutdown_all(std::time::Duration::from_millis(700)).await;
    }
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .manage(oauth::PendingOAuth::default())
        .manage(window_chrome::CompactFrames::default())
        .manage(updater::UpdaterState::default())
        .manage(claude_sidecar::state::SidecarSupervisorState::default())
        .invoke_handler(tauri::generate_handler![
            oauth::start_claude_oauth,
            oauth::complete_claude_oauth,
            oauth::get_claude_token,
            oauth::get_claude_account,
            oauth::disconnect_claude,
            claude_import::read_claude_code,
            claude_import::copy_claude_skill,
            google_oauth::start_google_oauth,
            google_oauth::get_google_account,
            google_oauth::disconnect_google,
            google_oauth::get_google_token,
            google_oauth::notify_signup,
            claude_sidecar::commands::claude_chat_start,
            claude_sidecar::commands::claude_list_models,
            // Distinct from claude_list_models above: that one reports what the
            // SDK handshake says the account may use (and lags a release by
            // days); this one is the authoritative catalog, GET /v1/models.
            models_catalog::anthropic_list_models,
            claude_sidecar::commands::claude_chat_cancel,
            claude_sidecar::commands::claude_chat_close_thread,
            claude_sidecar::commands::claude_chat_stop_task,
            claude_sidecar::commands::claude_chat_decision,
            claude_sidecar::commands::claude_chat_edit_ack,
            claude_sidecar::commands::claude_chat_query_result,
            claude_sidecar::commands::claude_chat_host_answer,
            claude_sidecar::commands::claude_title,
            fetch_url::fetch_url,
            fetch_url::fetch_binary,
            fetch_url::fetch_http,
            os_trash::move_to_trash,
            reveal::reveal_in_finder,
            sound::play_system_sound,
            git::git_init,
            git::git_commit,
            git::git_log_since_ref,
            git::git_advance_ref,
            git::git_revert,
            git::git_current_head,
            git::git_head_timestamp,
            git::git_is_dirty,
            git::git_show,
            git::git_ensure_gitignore_entries,
            app_quit,
            window_chrome::get_traffic_light_y,
            window_chrome::apply_window_chrome,
            window_chrome::set_window_compact,
            window_chrome::is_window_compact,
            updater::updater_check,
            updater::updater_install,
            updater::updater_status,
            updater::updater_arm_restart_when_idle,
            updater::updater_restart_veto,
            claude_sidecar::state::sidecar_status,
        ])
        .setup(|app| {
            // Resolve the per-device app-data base once, up front: git history
            // lives here (outside the synced vault) so the vault stays a
            // clean, sync-safe folder of user files.
            appdata::init(app.path().app_data_dir()?);

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
                let quit_item = MenuItemBuilder::new("Quit Octave")
                    .id("quit")
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)?;
                let close_window_item = MenuItemBuilder::new("Close Window")
                    .id("close-window")
                    .accelerator("CmdOrCtrl+W")
                    .build(app)?;
                // Manual update check — drives the same backend flow as the
                // startup loop and the About settings row.
                let check_updates_item = MenuItemBuilder::new("Check for Updates…")
                    .id("check-for-updates")
                    .build(app)?;

                // Octave (app menu)
                let app_submenu = SubmenuBuilder::new(app, "Octave")
                    .item(&PredefinedMenuItem::about(app, None, None)?)
                    .item(&check_updates_item)
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
                    match event.id().as_ref() {
                        // ⌘Q — quit the whole app. The frontend confirms if
                        // chats are streaming, then exits.
                        "quit" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.emit("app:close-requested", ());
                            }
                        }
                        // ⌘W — close the FOCUSED window only (macOS-native),
                        // exactly like the native red X. `.close()` fires
                        // CloseRequested → useWindowClose (editor windows)
                        // flushes / confirms / destroys. Does NOT quit.
                        "close-window" => {
                            let focused = app
                                .webview_windows()
                                .into_values()
                                .find(|w| w.is_focused().unwrap_or(false));
                            if let Some(window) = focused {
                                let _ = window.close();
                            }
                        }
                        // Menu "Check for Updates…" — run the same check flow
                        // the startup loop uses (busy-guarded, so it can't
                        // overlap an in-flight check/download).
                        "check-for-updates" => {
                            let app = app.clone();
                            tauri::async_runtime::spawn(async move {
                                updater::run_check(app, updater::CheckOrigin::Manual).await;
                            });
                        }
                        _ => {}
                    }
                });

                // Native toolbar chrome (larger corner radius + pinned
                // traffic-light Y). Shared with runtime-spawned project
                // windows via the apply_window_chrome command — see
                // apply_toolbar_chrome above.
                if let Some(main_window) = app.get_webview_window("main") {
                    window_chrome::apply_toolbar_chrome(&main_window);
                }
            }

            // Always open the main window at one fixed size, centered. macOS
            // restores the last window frame across launches (overriding the
            // tauri.conf size), so we re-assert it every launch for an
            // identical opening size + position. The window starts hidden
            // (`visible: false` in tauri.conf) so we can size/center it
            // offscreen and only then show it — no resize flash. This runs at
            // process startup only, so it doesn't fight the in-session compact
            // toggle (which stashes/restores its own frame).
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_size(tauri::LogicalSize::new(1440.0, 800.0));
                let _ = window.center();
                let _ = window.show();
                let _ = window.set_focus();
                // Re-apply the native chrome AFTER show(): on macOS 26 the
                // toolbar corner classification doesn't reliably take before
                // the window is realized, and pin the radius directly so it no
                // longer depends on that OS heuristic at all.
                #[cfg(target_os = "macos")]
                {
                    window_chrome::apply_toolbar_chrome(&window);
                    window_chrome::apply_corner_radius(&window);
                }
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

            // Auto-update: one process-wide checker in the Rust runtime — runs
            // regardless of which/how many windows are open (fixing the old
            // launcher-window-only gating). A first check ~5s after launch (so
            // it doesn't compete with cold start), then hourly. Auto-download:
            // a found update downloads + installs in the background (see
            // updater.rs); the user only drives the final restart. Release
            // builds only — dev has no installed bundle to replace.
            #[cfg(not(debug_assertions))]
            {
                let updater_app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    loop {
                        updater::run_check(updater_app.clone(), updater::CheckOrigin::Scheduled)
                            .await;
                        tokio::time::sleep(std::time::Duration::from_secs(60 * 60)).await;
                    }
                });
            }

            // "Restart when idle": a process-global loop that relaunches into a
            // staged update once the system goes idle (native idle time, not a
            // throttled webview timer) and no window vetoes. Armed by the
            // update-ready toast. Release + macOS only.
            #[cfg(all(not(debug_assertions), target_os = "macos"))]
            {
                let idle_app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    updater::run_idle_restart_loop(idle_app).await;
                });
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
                // Dock-icon click / app re-activation (macOS). Closing all
                // windows keeps the app alive; reopening RESUMES the last note:
                // prefer showing a hidden project window (its state is intact),
                // and only fall back to the launcher when no project window
                // exists. Only act when nothing is visible — otherwise macOS's
                // default (focus an existing window) is correct.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } => {
                    if !has_visible_windows {
                        let windows = app_handle.webview_windows();
                        let project = windows
                            .iter()
                            .find(|(label, _)| label.starts_with("project-"))
                            .map(|(_, w)| w.clone());
                        let target =
                            project.or_else(|| app_handle.get_webview_window("main"));
                        if let Some(window) = target {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
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
