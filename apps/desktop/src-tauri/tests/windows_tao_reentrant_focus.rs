//! Regression guard for the Windows UI-thread self-deadlock fixed by the vendored tao
//! (third_party/tao, upstream tao c704261c, tauri-apps/tauri#12531).
//!
//! tao 0.35.3 held the global `KEY_EVENT_BUILDERS` mutex while calling `PeekMessageW` in its
//! keyboard handler. A message sent from another thread (here `WM_KILLFOCUS` / `WM_SETFOCUS`) is
//! delivered inside that `PeekMessageW`, re-enters the keyboard handler and blocks forever on the
//! same non-reentrant mutex. This test floods a tao window with posted key messages while another
//! thread sends focus changes, and requires the window to keep answering `WM_NULL` within 2 s.

#![cfg(windows)]
#![allow(unsafe_code)]

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use tao::event::Event;
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::platform::run_return::EventLoopExtRunReturn;
use tao::platform::windows::{EventLoopBuilderExtWindows, WindowExtWindows};
use tao::window::WindowBuilder;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    PostMessageW, SMTO_ABORTIFHUNG, SMTO_BLOCK, SendMessageTimeoutW, WM_CHAR, WM_KEYDOWN, WM_KEYUP,
    WM_KILLFOCUS, WM_NULL, WM_SETFOCUS,
};

const FLOOD_FOR: Duration = Duration::from_secs(3);
const RESPONSIVE_WITHIN_MS: u32 = 2_000;

fn post(hwnd: isize, msg: u32, wparam: usize, lparam: isize) {
    // A full queue makes PostMessageW fail; the flood only needs the queue to stay busy.
    unsafe { PostMessageW(hwnd as _, msg, wparam, lparam) };
}

/// Returns false when the window's thread did not answer within `timeout_ms`.
fn send_with_timeout(hwnd: isize, msg: u32, wparam: usize, timeout_ms: u32) -> bool {
    let mut result = 0usize;
    let answered = unsafe {
        SendMessageTimeoutW(
            hwnd as _,
            msg,
            wparam,
            0,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            timeout_ms,
            &mut result,
        )
    };
    answered != 0
}

#[test]
fn keyboard_flood_with_cross_thread_focus_changes_keeps_ui_thread_responsive() {
    let (hwnd_tx, hwnd_rx) = mpsc::channel();
    let (proxy_tx, proxy_rx) = mpsc::channel();
    let ui = thread::spawn(move || {
        let mut event_loop = EventLoopBuilder::<()>::with_user_event()
            .with_any_thread(true)
            .build();
        let window = WindowBuilder::new()
            .with_title("tao reentrant focus regression")
            .with_visible(false)
            .build(&event_loop)
            .expect("create tao window");
        proxy_tx
            .send(event_loop.create_proxy())
            .expect("send proxy");
        hwnd_tx.send(window.hwnd()).expect("send hwnd");
        event_loop.run_return(move |event, _, control_flow| {
            let _keep_window_alive = &window;
            *control_flow = match event {
                Event::UserEvent(()) => ControlFlow::Exit,
                _ => ControlFlow::Wait,
            };
        });
    });
    let hwnd = hwnd_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("tao window created");
    let proxy = proxy_rx.recv().expect("event loop proxy");

    let stop = Arc::new(AtomicBool::new(false));
    let poster = {
        let stop = Arc::clone(&stop);
        thread::spawn(move || {
            // 'A': virtual key 0x41, scan code 0x1E, repeat count 1.
            let down = 1 | (0x1E << 16);
            let up = down | (1 << 30) | (1 << 31);
            while !stop.load(Ordering::Relaxed) {
                post(hwnd, WM_KEYDOWN, 0x41, down);
                post(hwnd, WM_CHAR, 0x61, down);
                post(hwnd, WM_KEYUP, 0x41, up);
            }
        })
    };
    let focus_sender = {
        let stop = Arc::clone(&stop);
        thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                send_with_timeout(hwnd, WM_KILLFOCUS, 0, 250);
                send_with_timeout(hwnd, WM_SETFOCUS, 0, 250);
            }
        })
    };

    let started = Instant::now();
    let mut hung = false;
    while started.elapsed() < FLOOD_FOR {
        if !send_with_timeout(hwnd, WM_NULL, 0, RESPONSIVE_WITHIN_MS) {
            hung = true;
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    stop.store(true, Ordering::Relaxed);
    poster.join().expect("poster thread");
    focus_sender.join().expect("focus sender thread");

    // On a deadlock the UI thread never returns; leave it detached so the test reports instead of
    // hanging the suite.
    assert!(
        !hung,
        "tao UI thread stopped answering WM_NULL within {RESPONSIVE_WITHIN_MS} ms during a \
         keyboard flood with cross-thread WM_KILLFOCUS/WM_SETFOCUS (reentrant input-lock deadlock)"
    );
    proxy.send_event(()).expect("event loop still running");
    ui.join().expect("tao event loop thread");
}
