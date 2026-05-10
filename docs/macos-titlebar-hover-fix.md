# macOS 타이틀바 영역 Hover Fix — Native 구현 가이드

> 상태: **미실시 (문서화만)**. 디자인 확정 후 진행 예정.
> 작성일: 2026-04-30
> 컨텍스트: writer-tauri, Tauri v2, WKWebView, `titleBarStyle: "Overlay"`

---

## 0. 문제 정의

WKWebView가 들어있는 NSWindow에서 **상단 ~28px (타이틀바 영역)** 의 `mouseMoved` 이벤트가 WKWebView로 dispatch되지 않음.

**증상**: 해당 영역의 HTML 버튼이 클릭(`:active`)은 되는데 hover(`:hover`)는 안 됨.

**원인**: `-[NSWindow sendEvent:]` 의 기본 구현이 mouseMoved를 신호등 hover 효과용 trackingArea로 흘려보내고, contentView로 dispatch하지 않음. mouseDown은 별도 경로라 통과.

**왜 Electron엔 없나**: Chromium이 `NativeWidgetMacNSWindow`로 NSWindow를 subclass해서 mouseMoved를 contentView로 강제 forward. WKWebView는 stock AppKit 동작 그대로 따름.

---

## 1. 최종 디렉토리 구조

```
src-tauri/
├── Cargo.toml                      ← objc2 의존성 추가
└── src/
    ├── lib.rs                      ← .setup()에서 patch 호출
    └── macos/
        ├── mod.rs                  ← #[cfg(target_os="macos")] 게이트
        ├── window_patch.rs         ← NSWindow subclass + sendEvent 오버라이드
        └── traffic_lights.rs       ← (선택) 신호등 위치 조정 + 풀스크린 훅
```

---

## 2. 의존성 (`Cargo.toml`)

기존 `[target.'cfg(unix)'.dependencies]`에 macOS 전용 블록 추가:

```toml
[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.5"
objc2-app-kit = { version = "0.2", features = [
  "NSWindow", "NSEvent", "NSResponder", "NSView",
  "NSApplication", "NSWindowDelegate", "NSNotification"
]}
objc2-foundation = "0.2"
block2 = "0.5"
```

`cocoa` crate는 deprecation 방향이라 신규는 **`objc2`-family** 권장 (decorum도 마이그레이션 중).

---

## 3. 핵심 — `sendEvent:` 오버라이드 (window_patch.rs)

목표: NSWindow subclass를 만들어 `sendEvent:`를 가로채고, `mouseMoved`/`mouseEntered`/`mouseExited` 이벤트를 **super 호출 후** contentView에도 강제 dispatch.

```rust
// src/macos/window_patch.rs
use objc2::{
    declare_class, msg_send_id, mutability,
    rc::Retained,
    runtime::AnyObject,
    sel, ClassType, DeclaredClass,
};
use objc2_app_kit::{NSEvent, NSEventType, NSResponder, NSView, NSWindow};
use objc2_foundation::MainThreadMarker;

declare_class!(
    pub struct EventForwardingWindow;

    unsafe impl ClassType for EventForwardingWindow {
        type Super = NSWindow;
        type Mutability = mutability::MainThreadOnly;
        const NAME: &'static str = "EventForwardingWindow";
    }

    impl DeclaredClass for EventForwardingWindow {}

    unsafe impl EventForwardingWindow {
        #[method(sendEvent:)]
        fn send_event(&self, event: &NSEvent) {
            // 1) 항상 super 먼저 — 신호등 hover, 윈도우 드래그 등 정상 동작 유지
            unsafe {
                let _: () = msg_send![super(self), sendEvent: event];
            }

            // 2) mouseMoved/Entered/Exited 만 contentView에도 강제 forward
            unsafe {
                let evt_type = event.r#type();
                let needs_forward = matches!(
                    evt_type,
                    NSEventType::MouseMoved
                    | NSEventType::MouseEntered
                    | NSEventType::MouseExited
                );
                if needs_forward {
                    if let Some(content_view) = self.contentView() {
                        let _: () = msg_send![&*content_view, mouseMoved: event];
                    }
                }
            }
        }
    }
);
```

**왜 super를 먼저 부르나** — 신호등 hover 효과(○ 안 X/–/+)는 AppKit이 자기 trackingArea로 처리. super를 안 부르면 신호등 hover 죽음. **둘 다 살리는 게 핵심.**

---

## 4. 기존 NSWindow의 isa 포인터를 새 클래스로 교체

Tauri가 이미 만든 NSWindow 인스턴스의 **클래스만 바꾸기** (isa swap):

```rust
// src/macos/window_patch.rs (이어서)
use objc2::runtime::Class;

pub fn patch_window(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let ns_window_ptr = window.ns_window()? as *mut AnyObject;
    if ns_window_ptr.is_null() {
        return Ok(());
    }

    unsafe {
        // mouseMoved 이벤트 받도록 enable
        let _: () = msg_send![ns_window_ptr, setAcceptsMouseMovedEvents: true];

        // isa swap: 인스턴스의 클래스를 우리 subclass로 교체
        let new_class: &Class = EventForwardingWindow::class();
        let _: () = msg_send![ns_window_ptr, setClass: new_class];

        // contentView에 NSTrackingArea 추가
        install_tracking_area(ns_window_ptr);
    }

    Ok(())
}

unsafe fn install_tracking_area(ns_window: *mut AnyObject) {
    let content_view: *mut AnyObject = msg_send![ns_window, contentView];
    if content_view.is_null() { return; }

    // NSTrackingArea options
    // MouseEnteredAndExited = 0x01
    // MouseMoved            = 0x02
    // ActiveAlways          = 0x80
    // InVisibleRect         = 0x200  ← 자동 리사이즈 추적
    let opts: u64 = 0x01 | 0x02 | 0x80 | 0x200;

    let bounds: objc2_foundation::CGRect = msg_send![content_view, bounds];
    let area: *mut AnyObject = msg_send![class!(NSTrackingArea), alloc];
    let area: *mut AnyObject = msg_send![
        area,
        initWithRect: bounds
        options: opts
        owner: content_view
        userInfo: std::ptr::null::<AnyObject>()
    ];
    let _: () = msg_send![content_view, addTrackingArea: area];
}
```

**왜 isa swap?** NSWindow를 새로 만들지 않고 Tauri가 만들어준 기존 인스턴스를 우리 클래스로 "변신"시키는 트릭. Cocoa에서 합법이고 Chromium도 비슷하게 함.

**`InVisibleRect`** 옵션 — 윈도우 리사이즈 시 trackingArea가 자동으로 따라감.

---

## 5. lib.rs에서 호출

```rust
// src/lib.rs
#[cfg(target_os = "macos")]
mod macos;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                let window = app.get_webview_window("main")
                    .ok_or("main window not found")?;
                macos::window_patch::patch_window(&window)?;
            }
            Ok(())
        })
        .invoke_handler(/* ... */)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

---

## 6. 풀스크린 / 신호등 위치 (선택)

신호등 자체를 strip 중앙에 정렬하고 싶다면:

```rust
pub unsafe fn reposition_traffic_lights(ns_window: *mut AnyObject, dy: f64) {
    use objc2_app_kit::NSWindowButton;
    for btn_kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        let btn: *mut AnyObject = msg_send![ns_window, standardWindowButton: btn_kind];
        if btn.is_null() { continue; }
        let frame: objc2_foundation::CGRect = msg_send![btn, frame];
        let new_origin = objc2_foundation::CGPoint {
            x: frame.origin.x,
            y: frame.origin.y - dy,
        };
        let _: () = msg_send![btn, setFrameOrigin: new_origin];
    }
}
```

**함정**: 풀스크린 enter/exit 시 AppKit이 신호등을 원위치로 reset함. → `NSWindowDidExitFullScreenNotification` observe해서 매번 재배치 필요. (decorum의 `traffic_lights.rs`가 이걸 함)

---

## 7. 검증 체크리스트

| 시나리오 | 기대 동작 |
|---|---|
| 신호등 위 hover | ○ 안 X/–/+ 정상 표시 (super 호출 효과) |
| SidebarTrigger hover (y < 28px) | **bg-sidebar-accent 정상 적용** ← 본 이슈 fix 확인 |
| SidebarTrigger 클릭 | 정상 토글 |
| 윈도우 리사이즈 | hover 영역 자동 따라옴 (InVisibleRect) |
| 풀스크린 토글 후 hover | 깨지지 않음 |
| 다른 데스크탑으로 이동 후 복귀 | hover 정상 |

콘솔 첫 로그 확인: `RUST_LOG=debug pnpm tauri dev`

---

## 8. 위험·주의

1. **`unsafe` 블록 다수** — Rust 안전 보장 밖. ASAN/Sanitizer 권장.
2. **isa swap은 AppKit 내부 가정에 의존** — macOS 메이저 업데이트 시 회귀 가능. CI macOS 13/14/15 매트릭스 권장.
3. **단일 윈도우 가정** — 멀티 윈도우면 윈도우 생성 시마다 `patch_window` 호출.
4. **objc2 0.5 → 0.6 마이그레이션 진행 중** — `=0.5.x` 잠금 또는 SHA pin.
5. **Tauri v3 나오면 `ns_window()` API 변경 가능** — 마이그레이션 시 이 모듈 점검.
6. **`declare_class!` 컴파일 에러 메시지가 cryptic** — 인내심 필요.

---

## 9. 참고 자료

- **decorum의 NSWindowDelegate / 신호등 코드**: [src-applib/src/macos/window.rs](https://github.com/clearlysid/tauri-plugin-decorum/blob/main/src-applib/src/macos/window.rs)
- **Chromium의 sendEvent 오버라이드**: [native_widget_mac_nswindow.mm](https://source.chromium.org/chromium/chromium/src/+/main:components/remote_cocoa/app_shim/native_widget_mac_nswindow.mm)
- **objc2 declare_class 사용법**: [docs.rs/objc2 — declare_class!](https://docs.rs/objc2/latest/objc2/macro.declare_class.html)
- **NSTrackingArea 옵션**: [Apple — NSTrackingAreaOptions](https://developer.apple.com/documentation/appkit/nstrackingarea/options)
- **Tauri NSWindow 접근**: [docs.rs — window.ns_window()](https://docs.rs/tauri/latest/tauri/window/struct.Window.html#method.ns_window)
- **decorum 사용처 조사**: HazelChat/hazel (637⭐), UNIkeEN/SJMCL (489⭐), amll-dev/amll-ttml-tool (335⭐), Kholid060/snippy (327⭐), pacholoamit/pachtop (183⭐) — 1인~소규모 인디 위주, 상용 reference 없음

---

## 10. 진행 순서 (덜 위험한 것부터)

1. **먼저 `setAcceptsMouseMovedEvents: true` + NSTrackingArea만 추가** → 5분 작업, 이것만으로 풀릴 가능성 검증.
2. 안 되면 **isa swap + sendEvent 오버라이드** 추가 (메인 작업).
3. 풀스크린/멀티 윈도우 엣지 케이스 처리.
4. 신호등 위치 조정은 **마지막**에 (시각적 finishing).

각 단계마다 commit해서 회귀 시 bisect 가능하게.

---

## 11. decorum 대안 평가 (요약)

| 옵션 | 장점 | 단점 |
|---|---|---|
| `tauri-plugin-decorum` 의존 | 신호등 reposition 즉시 사용 | crates.io 1.1.1이 1.5년 stale, mouseMoved 자체는 해결 안 해줌, 1인 maintainer |
| **decorum 코드 vendoring + 직접 작성** ✓ | 의존성 0, 필요한 부분만, mouseMoved도 통합 | 초기 구현 부담 ~250줄 |
| Electron 마이그레이션 | hover 자동 해결 | 번들 +150MB, 메모리 큼, 부적절 |

**권장**: decorum 코드를 참고만 하고 직접 작성 (vendoring) — 의존성 관리 부담 없음.
