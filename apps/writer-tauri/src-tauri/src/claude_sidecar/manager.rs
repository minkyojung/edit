// Owns the chat + title sidecar processes for the lifetime of the app,
// and supervises them — when a child exits unexpectedly, we respawn the
// affected sidecar in place so frontend invocations resume working.

#[cfg(debug_assertions)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, Weak};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;

use super::client::{ExitHandler, NotificationHandler, SidecarClient, SidecarError};

// Self-reference handle for exit closures. Set after the SidecarManager Arc
// is created, so the closures can find their way back to call restart_*.
type SelfRef = Arc<OnceLock<Weak<SidecarManager>>>;

#[derive(Copy, Clone, Debug)]
enum Mode {
    Chat,
    Title,
}

impl Mode {
    fn as_str(&self) -> &'static str {
        match self {
            Mode::Chat => "chat",
            Mode::Title => "title",
        }
    }
}

/// How a sidecar is launched. Captured at startup so restarts use the same
/// command without re-resolving paths.
#[derive(Clone)]
struct Launcher {
    program: PathBuf,
    /// Args that come BEFORE `--mode=...`. In dev that's the .mjs script
    /// path; in prod it's empty.
    pre_args: Vec<String>,
}

impl Launcher {
    fn args_for(&self, mode: &str) -> Vec<String> {
        let mut args = self.pre_args.clone();
        args.push(format!("--mode={mode}"));
        args
    }
}

pub struct SidecarManager {
    chat: RwLock<Arc<SidecarClient>>,
    title: RwLock<Arc<SidecarClient>>,
    self_ref: SelfRef,
    notification_handler: NotificationHandler,
    launcher: Launcher,
    app: AppHandle,
}

impl SidecarManager {
    pub async fn spawn_all(app: &AppHandle) -> Result<Arc<Self>, SidecarError> {
        let launcher = resolve_launcher(app)?;
        eprintln!(
            "[sidecar manager] spawning chat + title sidecars\n  program: {}\n  args: {:?}",
            launcher.program.display(),
            launcher.pre_args,
        );

        // Tell sidecars where the bundled Claude Code CLI lives. bun --compile
        // can't embed the SDK's platform-specific native binary, so it ships
        // alongside as its own externalBin and the sidecar wires it up via
        // pathToClaudeCodeExecutable. Set on the parent process so child
        // processes inherit it automatically.
        // In prod, the Agent SDK's optional native dep is inside the bundled
        // sidecar's node_modules and the SDK locates it on its own — no env
        // var needed. In dev, we point at the .pnpm store copy explicitly.
        if let Some(cli) = resolve_claude_cli(app) {
            std::env::set_var("CLAUDE_CODE_CLI_PATH", &cli);
            eprintln!("[sidecar manager] CLAUDE_CODE_CLI_PATH={}", cli.display());
        } else if cfg!(debug_assertions) {
            eprintln!("[sidecar manager] WARN: Claude CLI binary not found; chat will fail");
        } else {
            eprintln!("[sidecar manager] Claude CLI resolution delegated to bundled SDK");
        }

        let handler = build_notification_handler(app.clone());
        let self_ref: SelfRef = Arc::new(OnceLock::new());

        let chat_exit = build_exit(self_ref.clone(), app.clone(), Mode::Chat);
        let title_exit = build_exit(self_ref.clone(), app.clone(), Mode::Title);

        let chat = SidecarClient::spawn(
            &launcher.program,
            &launcher.args_for("chat"),
            handler.clone(),
            Some(chat_exit),
        )
        .await?;
        let title = SidecarClient::spawn(
            &launcher.program,
            &launcher.args_for("title"),
            handler.clone(),
            Some(title_exit),
        )
        .await?;

        let _ = chat
            .request("initialize", Some(json!({ "clientVersion": "0.1.0" })))
            .await?;
        let _ = title
            .request("initialize", Some(json!({ "clientVersion": "0.1.0" })))
            .await?;

        eprintln!("[sidecar manager] both sidecars initialized");

        let mgr = Arc::new(Self {
            chat: RwLock::new(Arc::new(chat)),
            title: RwLock::new(Arc::new(title)),
            self_ref: self_ref.clone(),
            notification_handler: handler,
            launcher,
            app: app.clone(),
        });

        // Wire the self-ref so the exit closures can find us when they fire.
        // Setting once is sufficient; the OnceLock is shared across closures.
        let _ = self_ref.set(Arc::downgrade(&mgr));

        match mgr.try_inject_token(app).await {
            Ok(true) => eprintln!("[sidecar manager] token injected at startup"),
            Ok(false) => {
                eprintln!("[sidecar manager] no OAuth token yet; chat will fail until sign-in")
            }
            Err(e) => eprintln!("[sidecar manager] startup token inject failed: {e}"),
        }
        Ok(mgr)
    }

    /// Snapshots the current chat client. Cheap; just clones an Arc.
    pub async fn chat_client(&self) -> Arc<SidecarClient> {
        self.chat.read().await.clone()
    }

    /// Snapshots the current title client.
    pub async fn title_client(&self) -> Arc<SidecarClient> {
        self.title.read().await.clone()
    }

    /// Reads the latest OAuth token (auto-refreshing if near expiry) and
    /// pushes it to both sidecars. Returns Ok(true) if a token was injected,
    /// Ok(false) if no token is available.
    pub async fn try_inject_token(&self, app: &AppHandle) -> Result<bool, SidecarError> {
        let token = match crate::oauth::get_claude_token(app.clone()).await {
            Ok(opt) => opt,
            Err(e) => {
                eprintln!("[sidecar manager] failed to read OAuth token: {e}");
                return Ok(false);
            }
        };
        match token {
            Some(t) => {
                self.set_token(&t).await?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Sends `setToken` to both sidecars. Idempotent — safe to call repeatedly
    /// to rotate the OAuth token without restarting either process.
    pub async fn set_token(&self, token: &str) -> Result<(), SidecarError> {
        let params = Some(json!({ "token": token }));
        let chat = self.chat_client().await;
        let title = self.title_client().await;
        let _: Value = chat.request("setToken", params.clone()).await?;
        let _: Value = title.request("setToken", params).await?;
        Ok(())
    }

    async fn restart(&self, mode: Mode) -> Result<(), SidecarError> {
        eprintln!("[sidecar manager] {} sidecar exited; respawning", mode.as_str());
        let exit_handler = build_exit(self.self_ref.clone(), self.app.clone(), mode);
        let client = SidecarClient::spawn(
            &self.launcher.program,
            &self.launcher.args_for(mode.as_str()),
            self.notification_handler.clone(),
            Some(exit_handler),
        )
        .await?;
        let _ = client
            .request("initialize", Some(json!({ "clientVersion": "0.1.0" })))
            .await?;
        let new_arc = Arc::new(client);

        match mode {
            Mode::Chat => *self.chat.write().await = new_arc.clone(),
            Mode::Title => *self.title.write().await = new_arc.clone(),
        }

        // Push the latest token to the freshly-spawned process.
        if let Ok(Some(token)) = crate::oauth::get_claude_token(self.app.clone()).await {
            let _: Value = new_arc
                .request("setToken", Some(json!({ "token": token })))
                .await?;
        }

        eprintln!("[sidecar manager] {} sidecar respawned", mode.as_str());
        Ok(())
    }
}

fn build_notification_handler(app: AppHandle) -> NotificationHandler {
    Arc::new(move |method, params| {
        // auth/refreshNeeded is internal: the sidecar is asking the host
        // to push a fresh token. Do it asynchronously and don't surface
        // anything to the frontend — the retry will either succeed
        // silently or fail with chat/error AUTH.
        if method == "auth/refreshNeeded" {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(state) = app.try_state::<Arc<SidecarManager>>() {
                    let manager = state.inner().clone();
                    match manager.try_inject_token(&app).await {
                        Ok(true) => eprintln!("[sidecar manager] refreshed token after AUTH"),
                        Ok(false) => {
                            eprintln!("[sidecar manager] AUTH retry: no token available")
                        }
                        Err(e) => eprintln!("[sidecar manager] AUTH retry inject failed: {e}"),
                    }
                }
            });
            return;
        }
        let event_name = match method.as_str() {
            "chat/event" => "claude:event",
            "chat/done" => "claude:done",
            "chat/error" => "claude:error",
            "chat/proposal" => "claude:proposal",
            _ => return,
        };
        if let Err(e) = app.emit(event_name, params) {
            eprintln!("[sidecar manager] emit {event_name} failed: {e}");
        }
    })
}

fn build_exit(self_ref: SelfRef, _app: AppHandle, mode: Mode) -> ExitHandler {
    Arc::new(move || {
        let self_ref = self_ref.clone();
        tauri::async_runtime::spawn(async move {
            let weak = match self_ref.get() {
                Some(w) => w.clone(),
                None => {
                    eprintln!(
                        "[sidecar manager] {} sidecar exited before manager wired up",
                        mode.as_str()
                    );
                    return;
                }
            };
            let Some(manager) = weak.upgrade() else { return };
            if let Err(e) = manager.restart(mode).await {
                eprintln!(
                    "[sidecar manager] {} sidecar restart failed: {e}",
                    mode.as_str()
                );
            }
        });
    })
}

/// Decide how to spawn sidecars on this build.
///
/// Dev: run the .mjs source through the system `node` so we can iterate
/// without rebuilding the Rust crate. Prod: run the compiled, self-contained
/// binary that Tauri ships next to the app's main executable, with no Node
/// dependency on the user's machine.
fn resolve_launcher(app: &AppHandle) -> Result<Launcher, SidecarError> {
    #[cfg(debug_assertions)]
    {
        let workspace_root = find_workspace_root(app);
        let script = workspace_root
            .join("apps")
            .join("writer-tauri")
            .join("sidecar")
            .join("src")
            .join("index.mjs");
        let node = which_node().unwrap_or_else(|| PathBuf::from("node"));
        return Ok(Launcher {
            program: node,
            pre_args: vec![script.to_string_lossy().to_string()],
        });
    }

    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        // Run our sidecar source through the bundled bun runtime. bun --compile
        // had an unsolvable stdin-shim limitation when piping to bun-compile
        // children (claude-cli), so we ship the runtime + source instead.
        // Both files come from Tauri's bundle: bun is an externalBin (lives
        // alongside the main exe), the sidecar is shipped as a Resource.
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .ok_or_else(|| {
                SidecarError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "current_exe has no parent",
                ))
            })?;
        let bun_name = if cfg!(target_os = "windows") { "bun.exe" } else { "bun" };
        let bun_path = exe_dir.join(bun_name);
        if !bun_path.exists() {
            return Err(SidecarError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("bundled bun not found at {}", bun_path.display()),
            )));
        }
        // Tauri stages Resources at .app/Contents/Resources on macOS; from
        // the main exe at .app/Contents/MacOS/<bin>, that's `../Resources`.
        let resources = exe_dir
            .parent()
            .map(|p| p.join("Resources"))
            .unwrap_or_else(|| exe_dir.clone());
        // Tauri stages files referenced via parent paths under `_up_/`.
        let script = resources
            .join("_up_")
            .join("sidecar-pkg")
            .join("src")
            .join("index.mjs");
        if !script.exists() {
            return Err(SidecarError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("sidecar script not found at {}", script.display()),
            )));
        }
        return Ok(Launcher {
            program: bun_path,
            pre_args: vec!["run".into(), script.to_string_lossy().into_owned()],
        });
    }
}

/// Resolve the Claude Code CLI binary that the Agent SDK needs to spawn.
///
/// Dev: pull it out of the .pnpm store, where the platform-specific
/// `@anthropic-ai/claude-agent-sdk-<arch>` package lives.
/// Prod: it's bundled next to the main exe via Tauri's externalBin.
fn resolve_claude_cli(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        let workspace_root = find_workspace_root(app);
        let pnpm = workspace_root.join("node_modules").join(".pnpm");
        let pkg_prefix = if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
            "@anthropic-ai+claude-agent-sdk-darwin-arm64@"
        } else if cfg!(target_os = "macos") {
            "@anthropic-ai+claude-agent-sdk-darwin-x64@"
        } else if cfg!(target_os = "linux") {
            "@anthropic-ai+claude-agent-sdk-linux-x64@"
        } else if cfg!(target_os = "windows") {
            "@anthropic-ai+claude-agent-sdk-win32-x64@"
        } else {
            return None;
        };
        let cli_name = if cfg!(target_os = "windows") { "claude.exe" } else { "claude" };
        let pkg_inner = pkg_prefix.trim_end_matches('@').trim_start_matches("@anthropic-ai+");
        let entries = std::fs::read_dir(&pnpm).ok()?;
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with(pkg_prefix) {
                let candidate = entry
                    .path()
                    .join("node_modules")
                    .join("@anthropic-ai")
                    .join(pkg_inner)
                    .join(cli_name);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
        None
    }

    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        // The Agent SDK's optional dep ships inside the bundled sidecar's
        // node_modules — it can find the binary on its own, no env needed.
        // Returning None keeps the sidecar from over-specifying.
        None
    }
}

#[cfg(debug_assertions)]
fn which_node() -> Option<PathBuf> {
    let path = std::env::var("PATH").ok()?;
    for dir in path.split(':') {
        let candidate = Path::new(dir).join("node");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(debug_assertions)]
fn find_workspace_root(app: &AppHandle) -> PathBuf {
    let mut dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    for _ in 0..10 {
        if dir
            .join("apps/writer-tauri/sidecar/src/index.mjs")
            .exists()
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
