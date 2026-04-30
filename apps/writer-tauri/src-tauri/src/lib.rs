use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::Manager;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

struct ProofServerHandle(Arc<Mutex<Option<Child>>>);

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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
