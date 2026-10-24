//! Keeps macOS Zoom's focus tracking from deadlocking Rally on activation.
//!
//! While Zoom is zoomed in, HIToolbox asks the activating app for its
//! focused element's bounds, synchronously on the main thread. With a
//! WKWebView as first responder that question goes to the web content
//! process, whose accessibility server first asks Rally's main thread to
//! authenticate the caller (an IPC with no timeout). The main thread is the
//! caller, so both sides wait forever. See PITFALLS.md.
//!
//! The query runs in the same event-loop pass that posts
//! `NSApplicationWillBecomeActiveNotification`, after it. So: take first
//! responder off every web view when that notification fires (the query then
//! sees the native window), and give it back on the next pass after
//! `NSApplicationDidBecomeActiveNotification`.

use std::cell::RefCell;
use std::ptr::{self, NonNull};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2::{msg_send, MainThreadMarker};
use objc2_app_kit::{
    NSApp, NSApplicationDidBecomeActiveNotification, NSApplicationWillBecomeActiveNotification,
    NSResponder, NSWindow,
};
use objc2_foundation::{NSNotification, NSNotificationCenter};

thread_local! {
    /// Windows whose web view focus is parked, with the responder to give back.
    static PARKED: RefCell<Vec<(Retained<NSWindow>, Retained<NSResponder>)>> =
        const { RefCell::new(Vec::new()) };
}

/// Must run on the main thread (Tauri's `setup` does).
pub fn install(app: &tauri::AppHandle) {
    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("[rally] zoom_focus_guard: not on main thread, not installed");
        return;
    };
    let park = RcBlock::new(move |_: NonNull<NSNotification>| park_web_focus(mtm));
    let handle = app.clone();
    let restore = RcBlock::new(move |_: NonNull<NSNotification>| {
        // Not inline: HIToolbox's query is still ahead in this pass.
        let _ = handle.run_on_main_thread(restore_web_focus);
    });
    let center = NSNotificationCenter::defaultCenter();
    // A nil queue runs the block synchronously on the posting (main) thread,
    // which is what puts parking ahead of the query. The center keeps the
    // observers alive for the life of the app.
    unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSApplicationWillBecomeActiveNotification),
            None,
            None,
            &park,
        );
        center.addObserverForName_object_queue_usingBlock(
            Some(NSApplicationDidBecomeActiveNotification),
            None,
            None,
            &restore,
        );
    }
}

fn park_web_focus(mtm: MainThreadMarker) {
    let windows = NSApp(mtm).windows();
    PARKED.with_borrow_mut(|parked| {
        for i in 0..windows.len() {
            let window = windows.objectAtIndex(i);
            let Some(responder) = window.firstResponder() else { continue };
            if unsafe { is_in_web_view(&responder) } && window.makeFirstResponder(None) {
                parked.push((window, responder));
            }
        }
    });
}

fn restore_web_focus() {
    for (window, responder) in PARKED.take() {
        // A click that activated Rally may already have placed focus; only
        // undo our own parking, which leaves the window as first responder.
        let still_parked = window.firstResponder().is_some_and(|r| {
            ptr::eq(Retained::as_ptr(&r).cast::<AnyObject>(), Retained::as_ptr(&window).cast())
        });
        if still_parked {
            window.makeFirstResponder(Some(&responder));
        }
    }
}

/// True when `responder` is a WKWebView or a view inside one.
unsafe fn is_in_web_view(responder: &NSResponder) -> bool {
    let (Some(web_cls), Some(view_cls)) = (AnyClass::get(c"WKWebView"), AnyClass::get(c"NSView"))
    else {
        return false;
    };
    let mut current: *mut AnyObject = (responder as *const NSResponder).cast_mut().cast();
    while let Some(obj) = current.as_ref() {
        let is_web: bool = msg_send![obj, isKindOfClass: web_cls];
        if is_web {
            return true;
        }
        let is_view: bool = msg_send![obj, isKindOfClass: view_cls];
        if !is_view {
            return false;
        }
        current = msg_send![obj, superview];
    }
    false
}
