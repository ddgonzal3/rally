//! Keeps macOS Zoom's focus tracking from deadlocking Rally on activation.
//!
//! While Zoom is zoomed in, HIToolbox asks the activating app for its
//! focused element's bounds, synchronously on the main thread. With a
//! WKWebView as first responder that question goes to the web content
//! process, whose accessibility server first asks Rally's main thread to
//! authenticate the caller (an IPC with no timeout). The main thread is the
//! caller, so both sides wait forever. See PITFALLS.md.
//!
//! The query runs when HIToolbox pulls the activation event off the queue,
//! before AppKit posts any activation notification, so nothing can step in
//! right before it. Instead no web view holds first responder while Rally is
//! inactive: park focus on resign, park again before the main thread sleeps
//! (catches a web view focused in the background, like `set_focus` from the
//! CLI server or a window opened at launch), and give it back on
//! `NSApplicationDidBecomeActiveNotification`, when the query is done.

use std::cell::RefCell;
use std::ptr::{self, NonNull};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2::{msg_send, MainThreadMarker};
use objc2_app_kit::{
    NSApp, NSApplicationDidBecomeActiveNotification, NSApplicationDidResignActiveNotification,
    NSResponder, NSWindow,
};
use objc2_core_foundation::{
    kCFRunLoopCommonModes, CFRunLoop, CFRunLoopActivity, CFRunLoopObserver,
};
use objc2_foundation::{NSNotification, NSNotificationCenter};

thread_local! {
    /// Windows whose web view focus is parked, with the responder to give back.
    static PARKED: RefCell<Vec<(Retained<NSWindow>, Retained<NSResponder>)>> =
        const { RefCell::new(Vec::new()) };
}

/// Must run on the main thread (Tauri's `setup` does).
pub fn install() {
    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("[rally] zoom_focus_guard: not on main thread, not installed");
        return;
    };
    let park = RcBlock::new(move |_: NonNull<NSNotification>| park_web_focus(mtm));
    let restore = RcBlock::new(|_: NonNull<NSNotification>| restore_web_focus());
    let center = NSNotificationCenter::defaultCenter();
    // A nil queue runs the blocks synchronously on the posting (main) thread.
    // The center keeps the observers alive for the life of the app.
    unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSApplicationDidResignActiveNotification),
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

    let idle = RcBlock::new(move |_: *mut CFRunLoopObserver, _: CFRunLoopActivity| {
        if !NSApp(mtm).isActive() {
            park_web_focus(mtm);
        }
    });
    let observer = unsafe {
        CFRunLoopObserver::with_handler(None, CFRunLoopActivity::BeforeWaiting.0, true, 0, Some(&idle))
    };
    if let (Some(run_loop), Some(observer)) = (CFRunLoop::main(), observer) {
        // The run loop retains the observer for the life of the app.
        run_loop.add_observer(Some(&observer), unsafe { kCFRunLoopCommonModes });
    }
}

fn park_web_focus(mtm: MainThreadMarker) {
    let windows = NSApp(mtm).windows();
    PARKED.with_borrow_mut(|parked| {
        for i in 0..windows.len() {
            let window = windows.objectAtIndex(i);
            let Some(responder) = window.firstResponder() else { continue };
            if !unsafe { is_in_web_view(&responder) } || !window.makeFirstResponder(None) {
                continue;
            }
            // A web view can take focus back while Rally is inactive (page
            // load, set_focus); keep only the latest responder per window.
            parked.retain(|(w, _)| !ptr::eq(Retained::as_ptr(w), Retained::as_ptr(&window)));
            parked.push((window, responder));
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
