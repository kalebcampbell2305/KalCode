//! Foreground-only macOS Fn observation through AppKit's local event monitor.
//!
//! A local monitor sees only events already dispatched to KalCode and requires neither Input
//! Monitoring nor Accessibility. Every event is returned unchanged so Globe, Dictation and the
//! hardware Fn layer retain their normal operating-system behavior.

// Audited AppKit local-monitor boundary; no global capture or event suppression.
#![allow(unsafe_code)]

use std::cell::RefCell;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
use tauri::AppHandle;

use super::FnInput;

const FUNCTION_KEY_CODE: u16 = 0x3f;

thread_local! {
    /// AppKit local monitors belong to the main thread. Keeping the token here allows an exact
    /// remove on process exit without making an Objective-C object cross threads.
    static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

pub fn install(app: &AppHandle) -> bool {
    MONITOR.with(|slot| {
        if slot.borrow().is_some() {
            return true;
        }
        let app = app.clone();
        let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit gives the block a non-null NSEvent that remains valid for the
            // duration of this synchronous callback. It is never retained or used afterward.
            let event_ref = unsafe { event.as_ref() };
            match event_ref.r#type() {
                NSEventType::FlagsChanged if event_ref.keyCode() == FUNCTION_KEY_CODE => {
                    let flags = event_ref.modifierFlags();
                    if flags.contains(NSEventModifierFlags::Function) {
                        let held_modifier = NSEventModifierFlags::Shift
                            | NSEventModifierFlags::Control
                            | NSEventModifierFlags::Option
                            | NSEventModifierFlags::Command;
                        if flags.intersects(held_modifier) {
                            super::on_fn_input(&app, FnInput::Other);
                        } else {
                            super::on_fn_input(&app, FnInput::Down);
                        }
                    } else {
                        super::on_fn_input(&app, FnInput::Up);
                    }
                }
                NSEventType::FlagsChanged | NSEventType::KeyDown => {
                    // No key code or content crosses this boundary; the gesture needs only the
                    // fact that standalone Fn became a chord.
                    super::on_fn_input(&app, FnInput::Other);
                }
                _ => {}
            }
            // Never suppress or replace the event.
            event.as_ptr()
        });
        // SAFETY: the block returns exactly the NSEvent pointer AppKit supplied (never null or a
        // different object), and the retained monitor token is removed on the same main thread.
        let monitor = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::FlagsChanged | NSEventMask::KeyDown,
                &handler,
            )
        };
        *slot.borrow_mut() = monitor;
        slot.borrow().is_some()
    })
}

pub fn remove() {
    MONITOR.with(|slot| {
        if let Some(monitor) = slot.borrow_mut().take() {
            // SAFETY: `monitor` is the token returned by addLocalMonitor above and removal runs
            // on AppKit's event-loop thread during `RunEvent::Exit`.
            unsafe { NSEvent::removeMonitor(&monitor) };
        }
    });
}
