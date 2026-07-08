mod anthropic;
mod appdata;
pub mod claude_sidecar;
mod events;
mod fetch_url;
mod git;
mod github;
mod oauth;
mod os_trash;
mod reveal;
mod sound;
mod secure_storage;
mod vault_sync;

use tauri::{Emitter, Manager};

// proof-server lifecycle removed in Phase 3.D. The app no longer spawns
// a bundled sidecar — every doc operation runs against the local Y.Doc
// + IDB. Removing the spawn eliminates the `[collab] failed to derive
// markdown` log class and shaves ~0.5s off cold boot.

#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Returns the macOS traffic-light close button's vertical center, in
/// CSS pixels from the window's top edge. The HTML chrome uses this to
/// align its own toolbar row with the system stoplights regardless of
/// macOS version / toolbar style.
///
/// The conversion does two coordinate swaps:
///   1. Close button → window base coords via `convertRect:toView:nil`,
///      because the button's `frame` is in its superview's coords
///      (titlebar container view, not the window itself).
///   2. AppKit (bottom-up) → CSS (top-down) using the window's frame
///      height.
///
/// Returns 0.0 if the measurement fails (no window, no close button,
/// non-macOS). The JS caller treats 0 as "use the CSS fallback".
#[tauri::command]
fn get_traffic_light_y(window: tauri::WebviewWindow) -> f64 {
    #[cfg(target_os = "macos")]
    {
        use objc2::{
            encode::{Encode, Encoding},
            msg_send,
            runtime::AnyObject,
        };

        #[repr(C)]
        #[derive(Clone, Copy)]
        struct NSPoint {
            x: f64,
            y: f64,
        }
        #[repr(C)]
        #[derive(Clone, Copy)]
        struct NSSize {
            width: f64,
            height: f64,
        }
        #[repr(C)]
        #[derive(Clone, Copy)]
        struct NSRect {
            origin: NSPoint,
            size: NSSize,
        }

        // Match the Objective-C encodings AppKit expects so msg_send!
        // can pass these by value across the boundary.
        unsafe impl Encode for NSPoint {
            const ENCODING: Encoding =
                Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
        }
        unsafe impl Encode for NSSize {
            const ENCODING: Encoding =
                Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
        }
        unsafe impl Encode for NSRect {
            const ENCODING: Encoding =
                Encoding::Struct("CGRect", &[NSPoint::ENCODING, NSSize::ENCODING]);
        }

        let Ok(ns_window_ptr) = window.ns_window() else {
            return 0.0;
        };
        let ns_window = ns_window_ptr as *mut AnyObject;
        if ns_window.is_null() {
            return 0.0;
        }

        unsafe {
            // NSWindowButton.closeButton raw value = 0.
            let close_btn: *mut AnyObject = msg_send![ns_window, standardWindowButton: 0isize];
            if close_btn.is_null() {
                return 0.0;
            }
            let btn_frame: NSRect = msg_send![close_btn, frame];
            let superview: *mut AnyObject = msg_send![close_btn, superview];
            if superview.is_null() {
                return 0.0;
            }
            let null_view: *mut AnyObject = std::ptr::null_mut();
            let in_window: NSRect = msg_send![
                superview,
                convertRect: btn_frame,
                toView: null_view
            ];
            let window_frame: NSRect = msg_send![ns_window, frame];
            let css_y_top = window_frame.size.height - in_window.origin.y - in_window.size.height;
            css_y_top + in_window.size.height / 2.0
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        0.0
    }
}

/// Attach an empty NSToolbar so macOS Tahoe classifies the window as a
/// "toolbar window" and applies the larger corner radius (~26pt vs the
/// titlebar-only ~16pt). The toolbar carries no items and
/// titleBarStyle=Overlay lets our HTML chrome render over it, so this adds
/// no visible surface — it only flips the system's radius classifier.
///
/// toolbarStyle=Unified (=3) pins the toolbar height to the 52pt unified
/// band. That locks the traffic lights' Y to a known value (center y = 26pt)
/// so the HTML header can match it via --header-h. Without an explicit style,
/// macOS picks Automatic and the lights drift.
///
/// Applied to the config-defined `main` window in `setup`, and to every
/// runtime-spawned project window via the `apply_window_chrome` command —
/// otherwise the per-project windows lose the radius + light alignment.
#[cfg(target_os = "macos")]
fn apply_toolbar_chrome(window: &tauri::WebviewWindow) {
    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    use objc2::{class, msg_send, runtime::AnyObject};
    let ns_window = ns_window_ptr as *mut AnyObject;
    if ns_window.is_null() {
        return;
    }
    unsafe {
        let toolbar_class = class!(NSToolbar);
        let toolbar: *mut AnyObject = msg_send![toolbar_class, alloc];
        let toolbar: *mut AnyObject = msg_send![toolbar, init];
        let _: () = msg_send![ns_window, setToolbar: toolbar];
        // NSWindowToolbarStyle.unified raw value = 3
        // (automatic=0, expanded=1, preference=2, unified=3, unifiedCompact=4)
        let _: () = msg_send![ns_window, setToolbarStyle: 3isize];
    }
}

/// Re-apply the native window chrome (NSToolbar corner radius + unified
/// toolbar style) to the window with `label`. The frontend calls this after
/// spawning a per-project window so it matches the config-defined `main`
/// window's chrome. Resolves the target by label (a bare `WebviewWindow`
/// argument would inject the *calling* window, not the new one). No-ops off
/// macOS or when the label is unknown.
#[tauri::command]
fn apply_window_chrome(app: tauri::AppHandle, label: String) {
    if let Some(window) = app.get_webview_window(&label) {
        #[cfg(target_os = "macos")]
        apply_toolbar_chrome(&window);
        #[cfg(not(target_os = "macos"))]
        let _ = window;
    }
}

/// Per-window full-frame stash, so leaving compact restores the exact size +
/// position the window had when it entered. Keyed by window label (the main
/// window and any per-project windows each get their own slot).
#[derive(Default)]
struct CompactFrames(std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, [f64; 4]>>>);

/// Animate the window between its full size and the compact (Raycast-Notes)
/// panel — natively, so the transition is smooth (the JS window API only sets
/// size instantly).
///
/// The same NSWindow is resized, never recreated, so the webview — and with it
/// the editor's in-flight content (text, cursor, scroll) — survives untouched.
/// The full frame is stashed on the way in and restored on the way out. Min/max
/// are widened *before* and tightened *after* the animation so the size
/// constraints can't clamp the frame mid-flight. The top-left corner is held
/// fixed while shrinking (AppKit frames are bottom-left origin, so we raise
/// origin.y by the height delta).
#[tauri::command]
fn set_window_compact(
    window: tauri::WebviewWindow,
    frames: tauri::State<'_, CompactFrames>,
    compact: bool,
) {
    #[cfg(target_os = "macos")]
    {
        use objc2::{
            encode::{Encode, Encoding},
            msg_send,
            runtime::AnyObject,
        };

        #[repr(C)]
        #[derive(Clone, Copy)]
        struct NSPoint {
            x: f64,
            y: f64,
        }
        #[repr(C)]
        #[derive(Clone, Copy)]
        struct NSSize {
            width: f64,
            height: f64,
        }
        #[repr(C)]
        #[derive(Clone, Copy)]
        struct NSRect {
            origin: NSPoint,
            size: NSSize,
        }
        unsafe impl Encode for NSPoint {
            const ENCODING: Encoding =
                Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
        }
        unsafe impl Encode for NSSize {
            const ENCODING: Encoding =
                Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
        }
        unsafe impl Encode for NSRect {
            const ENCODING: Encoding =
                Encoding::Struct("CGRect", &[NSPoint::ENCODING, NSSize::ENCODING]);
        }

        // Compact panel geometry, in points: opening size + the bounds the user
        // may drag-resize within. Full minimum mirrors tauri.conf.json.
        const COMPACT_W: f64 = 400.0;
        const COMPACT_H: f64 = 640.0;
        const COMPACT_MIN: NSSize = NSSize { width: 360.0, height: 440.0 };
        const COMPACT_MAX: NSSize = NSSize { width: 600.0, height: 760.0 };
        const FULL_MIN: NSSize = NSSize { width: 800.0, height: 600.0 };
        const NO_MAX: NSSize = NSSize { width: 100000.0, height: 100000.0 };

        let store = frames.0.clone();
        let label = window.label().to_string();
        let win = window.clone();
        // AppKit must be touched on the main thread; setFrame:animate: also
        // drives its own run loop for the animation.
        let _ = window.run_on_main_thread(move || unsafe {
            let Ok(ptr) = win.ns_window() else {
                return;
            };
            let ns = ptr as *mut AnyObject;
            if ns.is_null() {
                return;
            }

            if compact {
                let frame: NSRect = msg_send![ns, frame];
                store.lock().unwrap().insert(
                    label.clone(),
                    [frame.origin.x, frame.origin.y, frame.size.width, frame.size.height],
                );
                // Hold the top edge fixed as the window shrinks.
                let new_y = frame.origin.y + (frame.size.height - COMPACT_H);
                let target = NSRect {
                    origin: NSPoint { x: frame.origin.x, y: new_y },
                    size: NSSize { width: COMPACT_W, height: COMPACT_H },
                };
                let _: () = msg_send![ns, setMinSize: COMPACT_MIN];
                // animate:false — instant resize. The system's setFrame
                // animation read poorly (esp. on expand), so it's off for now.
                let _: () = msg_send![ns, setFrame: target, display: true, animate: false];
                let _: () = msg_send![ns, setMaxSize: COMPACT_MAX];
                // Raycast-panel behavior: float above other apps and show on
                // every Space (incl. over full-screen apps).
                // NSFloatingWindowLevel = 3.
                let _: () = msg_send![ns, setLevel: 3isize];
                // canJoinAllSpaces (1<<0) | fullScreenAuxiliary (1<<8) = 257.
                let _: () = msg_send![ns, setCollectionBehavior: 257usize];
            } else {
                let saved = store.lock().unwrap().remove(&label);
                let _: () = msg_send![ns, setMaxSize: NO_MAX];
                if let Some(f) = saved {
                    let target = NSRect {
                        origin: NSPoint { x: f[0], y: f[1] },
                        size: NSSize { width: f[2], height: f[3] },
                    };
                    let _: () = msg_send![ns, setFrame: target, display: true, animate: false];
                }
                let _: () = msg_send![ns, setMinSize: FULL_MIN];
                // Back to a normal window: NSNormalWindowLevel = 0, default
                // collection behavior.
                let _: () = msg_send![ns, setLevel: 0isize];
                let _: () = msg_send![ns, setCollectionBehavior: 0usize];
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, frames, compact);
    }
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
        .manage(github::PendingGitHubAuth::default())
        .manage(CompactFrames::default())
        .invoke_handler(tauri::generate_handler![
            oauth::start_claude_oauth,
            oauth::complete_claude_oauth,
            oauth::get_claude_token,
            oauth::get_claude_account,
            oauth::disconnect_claude,
            claude_sidecar::commands::claude_chat_start,
            claude_sidecar::commands::claude_list_models,
            claude_sidecar::commands::claude_chat_cancel,
            claude_sidecar::commands::claude_chat_decision,
            claude_sidecar::commands::claude_chat_edit_ack,
            claude_sidecar::commands::claude_title,
            fetch_url::fetch_url,
            fetch_url::fetch_binary,
            fetch_url::fetch_http,
            os_trash::move_to_trash,
            reveal::reveal_in_finder,
            sound::play_system_sound,
            anthropic::anthropic_messages_create,
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
            events::commands::events_insert,
            events::commands::events_query,
            events::commands::events_search,
            github::start_github_device_flow,
            github::poll_github_device_flow,
            github::get_github_account,
            github::get_github_token,
            github::disconnect_github,
            github::github_sync,
            github::github_list_repos,
            vault_sync::vault_backup_init,
            vault_sync::vault_push,
            vault_sync::vault_restore,
            vault_sync::vault_pull,
            app_quit,
            get_traffic_light_y,
            apply_window_chrome,
            set_window_compact,
        ])
        .setup(|app| {
            // Resolve the per-device app-data base once, up front: git history
            // and the events.db cache live here (outside the synced vault) so
            // the vault stays a clean, sync-safe folder of user files.
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

                // Octave (app menu)
                let app_submenu = SubmenuBuilder::new(app, "Octave")
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
                        _ => {}
                    }
                });

                // Native toolbar chrome (larger corner radius + pinned
                // traffic-light Y). Shared with runtime-spawned project
                // windows via the apply_window_chrome command — see
                // apply_toolbar_chrome above.
                if let Some(main_window) = app.get_webview_window("main") {
                    apply_toolbar_chrome(&main_window);
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
