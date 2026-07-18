// Native window chrome: traffic-light alignment, toolbar + corner-radius, and
// the compact panel. The commands are cross-platform (no-ops off macOS); the
// AppKit (objc2) internals are macOS-gated. Extracted from lib.rs so the entry
// point stays a thin builder, and so the NSPoint/NSSize/NSRect encodings that
// two commands need live in one place instead of being redeclared per function.

use tauri::Manager;

// ---------------------------------------------------------------------------
// macOS AppKit geometry. `msg_send!` passes these structs by value across the
// ObjC boundary, so each carries the exact Objective-C encoding AppKit expects.
// Compiled only on macOS; every user is inside a `#[cfg(target_os = "macos")]`
// command block.
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
use objc2::encode::{Encode, Encoding};

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct NSPoint {
    x: f64,
    y: f64,
}
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct NSSize {
    width: f64,
    height: f64,
}
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct NSRect {
    origin: NSPoint,
    size: NSSize,
}

#[cfg(target_os = "macos")]
unsafe impl Encode for NSPoint {
    const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}
#[cfg(target_os = "macos")]
unsafe impl Encode for NSSize {
    const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
}
#[cfg(target_os = "macos")]
unsafe impl Encode for NSRect {
    const ENCODING: Encoding =
        Encoding::Struct("CGRect", &[NSPoint::ENCODING, NSSize::ENCODING]);
}

/// The window corner radius, matching CSS `--window-radius` (26px).
#[cfg(target_os = "macos")]
const WINDOW_CORNER_RADIUS: f64 = 26.0;

// ---------------------------------------------------------------------------
// Commands and helpers.
// ---------------------------------------------------------------------------

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
pub fn get_traffic_light_y(window: tauri::WebviewWindow) -> f64 {
    #[cfg(target_os = "macos")]
    {
        use objc2::{msg_send, runtime::AnyObject};

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
pub fn apply_toolbar_chrome(window: &tauri::WebviewWindow) {
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

/// Round the window corners to {@link WINDOW_CORNER_RADIUS} DIRECTLY, instead
/// of relying on macOS's toolbar-window classifier (the `apply_toolbar_chrome`
/// trick) to imply a large corner — which macOS 26 (Tahoe) stopped honoring,
/// leaving the window with a small default radius. The window is `transparent`,
/// so masking the content layer to a rounded rect rounds the whole visible app;
/// the traffic lights live in the titlebar frame view (not the content view),
/// so they're untouched. `invalidateShadow` re-fits the drop shadow to the
/// new curve. Continuous (squircle) curve matches macOS's native corner shape.
#[cfg(target_os = "macos")]
pub fn apply_corner_radius(window: &tauri::WebviewWindow) {
    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    use objc2::{class, msg_send, runtime::AnyObject};
    let ns_window = ns_window_ptr as *mut AnyObject;
    if ns_window.is_null() {
        return;
    }
    unsafe {
        let content: *mut AnyObject = msg_send![ns_window, contentView];
        if content.is_null() {
            return;
        }
        let _: () = msg_send![content, setWantsLayer: true];
        let layer: *mut AnyObject = msg_send![content, layer];
        if layer.is_null() {
            return;
        }
        let _: () = msg_send![layer, setCornerRadius: WINDOW_CORNER_RADIUS];
        let _: () = msg_send![layer, setMasksToBounds: true];
        let cstr = b"continuous\0".as_ptr() as *const std::os::raw::c_char;
        let curve: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: cstr];
        if !curve.is_null() {
            let _: () = msg_send![layer, setCornerCurve: curve];
        }
        let _: () = msg_send![ns_window, invalidateShadow];
    }
}

/// Re-apply the native window chrome (NSToolbar corner radius + unified
/// toolbar style) to the window with `label`. The frontend calls this after
/// spawning a per-project window so it matches the config-defined `main`
/// window's chrome. Resolves the target by label (a bare `WebviewWindow`
/// argument would inject the *calling* window, not the new one). No-ops off
/// macOS or when the label is unknown.
#[tauri::command]
pub fn apply_window_chrome(app: tauri::AppHandle, label: String) {
    if let Some(window) = app.get_webview_window(&label) {
        #[cfg(target_os = "macos")]
        {
            apply_toolbar_chrome(&window);
            apply_corner_radius(&window);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = window;
    }
}

/// Per-window full-frame stash, so leaving compact restores the exact size +
/// position the window had when it entered. Keyed by window label (the main
/// window and any per-project windows each get their own slot).
#[derive(Default)]
pub struct CompactFrames(
    std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, [f64; 4]>>>,
);

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
pub fn set_window_compact(
    window: tauri::WebviewWindow,
    frames: tauri::State<'_, CompactFrames>,
    compact: bool,
) {
    #[cfg(target_os = "macos")]
    {
        use objc2::{msg_send, runtime::AnyObject};

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

/// Whether the window is currently in the compact panel.
///
/// `CompactFrames` holds a stashed full frame IFF the window is compact, so the
/// presence of this window's entry is the durable truth. Rust state outlives
/// the webview, so this survives a webview reload — letting the frontend
/// re-hydrate `mode` after a reload without ever measuring the window size.
#[tauri::command]
pub fn is_window_compact(
    window: tauri::WebviewWindow,
    frames: tauri::State<'_, CompactFrames>,
) -> bool {
    frames.0.lock().unwrap().contains_key(window.label())
}
