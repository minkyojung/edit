use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use tauri::Manager;

struct ProofServerHandle(Arc<Mutex<Option<Child>>>);

fn find_workspace_root(app_handle: &tauri::AppHandle) -> PathBuf {
    let mut dir = app_handle
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    for _ in 0..8 {
        if dir.join("node_modules").exists() {
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

fn spawn_proof_server(workspace_root: &PathBuf) -> Option<Child> {
    let tsx = workspace_root.join("node_modules/.bin/tsx");
    let server_entry = workspace_root.join("node_modules/proof-sdk/server/index.ts");

    if !tsx.exists() || !server_entry.exists() {
        eprintln!("[proof-server] tsx or server entry not found");
        return None;
    }

    match Command::new(&tsx)
        .arg(&server_entry)
        .env("PORT", "4000")
        .current_dir(workspace_root.join("node_modules/proof-sdk"))
        .spawn()
    {
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
        .setup(|app| {
            let workspace_root = find_workspace_root(app.handle());
            println!("[proof-server] workspace root: {}", workspace_root.display());

            let child = spawn_proof_server(&workspace_root);
            let state = app.state::<ProofServerHandle>();
            *state.0.lock().unwrap() = child;

            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
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
                        let _ = child.kill();
                        println!("[proof-server] killed on window destroy");
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
