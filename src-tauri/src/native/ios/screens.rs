use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::OnceLock;

use tauri::{Emitter, Manager};

use crate::screens::hub::{Hub, Posted, Taken};
use crate::screens::message::MAX_MESSAGE_BYTES;

/// The screens' bridge (`src-tauri/apple/DevotScreens`, docs/specs/iphone-screens.md). Swift
/// calls `ScreensCall` with a request number and UTF-8 JSON valid until the call returns, and hears
/// the answer through its `ScreensReply`, now or later, from any thread; it copies the bytes before
/// the callback returns. Rust hands Swift these functions at install, so it exports no symbol.
type ScreensReply = extern "C" fn(request: u64, json: *const u8, len: usize);
type ScreensCall = extern "C" fn(request: u64, json: *const u8, len: usize, reply: ScreensReply);
type ScreensLog = extern "C" fn(level: u8, line: *const u8, len: usize);

// SAFETY: these are the `@_cdecl` functions of the DevotScreens package's bridge, with the same C
// types; the iOS app links the Swift package that defines them.
unsafe extern "C" {
    fn devot_screens_install(
        web_view: *mut c_void,
        root: *mut c_void,
        call: ScreensCall,
        log: ScreensLog,
    ) -> bool;
    fn devot_screens_deliver(json: *const u8, len: usize);
}

pub const SCREENS_EVENT: &str = "devot://screens";
const MAX_LOG_BYTES: usize = 512;

static HUB: Hub<ScreensReply> = Hub::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

fn copy_message(json: *const u8, len: usize, limit: usize) -> Result<Vec<u8>, &'static str> {
    if json.is_null() {
        return Err("E_SCREENS_MESSAGE_INVALID");
    }
    if len > limit {
        return Err("E_SCREENS_MESSAGE_TOO_LARGE");
    }
    // SAFETY: Swift passes `len` initialised bytes that stay valid and unchanged until the call
    // that received them returns, and this copy happens inside it.
    Ok(unsafe { std::slice::from_raw_parts(json, len) }.to_vec())
}

fn send(reply: ScreensReply, request: u64, json: &[u8]) {
    reply(request, json.as_ptr(), json.len());
}

extern "C" fn screens_call(request: u64, json: *const u8, len: usize, reply: ScreensReply) {
    HUB.serve(
        request,
        || copy_message(json, len, MAX_MESSAGE_BYTES),
        reply,
        send,
        forward,
    );
}

fn forward(message: serde_json::Value) -> bool {
    APP.get().is_some_and(|app| {
        app.emit_to(crate::MAIN_WINDOW, SCREENS_EVENT, message)
            .is_ok()
    })
}

extern "C" fn screens_log(level: u8, line: *const u8, len: usize) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let line = copy_message(line, len, MAX_LOG_BYTES).unwrap_or_default();
        // A refused line is never logged itself: it may hold anything.
        match crate::screens::log_line(level, &line) {
            Some((level, line)) => log::log!(level, "{line}"),
            None => log::warn!("W_SCREENS_LOG_REFUSED"),
        }
    }));
}

fn deliver(json: &[u8]) {
    // SAFETY: Swift copies the `json.len()` bytes before it returns and keeps no pointer to them.
    unsafe { devot_screens_deliver(json.as_ptr(), json.len()) }
}

/// Attaches the native screens to tao's root view controller, once, on the main thread. Without
/// them (Swift refused, or it failed) the page keeps the web shell: `screens_take` says so.
pub fn install_screens(window: &tauri::WebviewWindow) {
    if APP.set(window.app_handle().clone()).is_err() {
        return;
    }
    let result = window.with_webview(|webview| {
        let installed = crate::native::guarded("W_SCREENS_INSTALL_FAILED", || {
            // SAFETY: `inner()` is the window's live WKWebView and `view_controller()` tao's live
            // root view controller; `with_webview` runs this on the main thread, where Swift needs
            // it; `screens_call` and `screens_log` are plain functions that live as long as the
            // process.
            unsafe {
                devot_screens_install(
                    webview.inner(),
                    webview.view_controller(),
                    screens_call,
                    screens_log,
                )
            }
            .then_some(())
        })
        .is_some();
        HUB.set_installed(installed);
        if installed {
            log::info!("I_SCREENS_INSTALLED");
        } else {
            log::warn!("W_SCREENS_NOT_INSTALLED");
        }
    });
    if result.is_err() {
        log::warn!("W_NATIVE_WEBVIEW_UNAVAILABLE");
    }
}

pub fn screens_take() -> Taken {
    HUB.take()
}

/// The page's reply goes to the call that waits for it, and a notice to Swift; a reply nothing
/// waits for is dropped.
pub fn screens_post(message: &[u8]) -> Result<(), &'static str> {
    match HUB.post(message) {
        Ok(Posted::Reply(reply, request, json)) => send(reply, request, &json),
        Ok(Posted::Notice(json)) => deliver(&json),
        Ok(Posted::Unmatched(request)) => log::warn!("W_SCREENS_REPLY_UNMATCHED id={request}"),
        Err(code) => {
            log::warn!("W_SCREENS_POST_REFUSED code={code}");
            return Err(code);
        }
    }
    Ok(())
}

pub fn screens_page_started() {
    for (reply, request, json) in HUB.page_started() {
        send(reply, request, &json);
    }
}
