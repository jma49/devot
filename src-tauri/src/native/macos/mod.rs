//! macOS-only native code: AppKit and WebKit calls through objc2, and the C
//! library calls the standard library has no safe form for.
//!
//! Every private API call is guarded by `respondsToSelector:` (and every
//! object it returns by its class) and runs inside `guarded`, which catches
//! an Objective-C exception as well as a Rust panic: `catch_unwind` alone
//! cannot stop an Objective-C exception, which would end the app. When an API
//! is missing or fails, the app keeps its default behaviour and logs a code.

mod accent;
mod alert;
mod crash;
mod editor_menu;
mod format_keys;
mod icloud;
mod pasteboard;
mod pdf;
mod print;
mod symbols;
mod system;
mod text;
mod webkit;
mod window;

pub use accent::{observe_accent_changes, system_accent};
pub use alert::show_critical_alert;
pub use crash::{CrashHandler, attach_crash_handler, crash_handler_attached, detach_crash_handler};
#[cfg(debug_assertions)]
pub use crash::{crash_with_bad_access, crash_with_call_to, load_bundle};
pub use editor_menu::{editor_menu, self_test_editor_menu};
pub use format_keys::{
    clear_app_menu_key_equivalents, clear_item_key_equivalents, clear_key_equivalents,
    give_format_menu_keys_priority, self_test_format_menu_keys, self_test_marked_text,
};
pub(crate) use icloud::{holds_icloud_container, receive_icloud_notices};
pub use pasteboard::{
    PasteboardImage, clear_clipboard_if_unchanged, pasteboard_image, read_clipboard_text,
    self_test_image_pasteboard, write_clipboard_image, write_clipboard_text, write_image,
    write_secret_clipboard_text,
};
pub use pdf::stamp_pdf;
pub use print::{
    PRINT_POLICY, PrintDone, PrintJob, PrintJobState, PrintTarget, SelfTestPage, print_html,
    print_in_window, print_note, print_note_in_window, self_test_pdf_pages, self_test_print_jobs,
    self_test_print_note_to_pdf, self_test_print_to_pdf, system_paper, with_print_policy,
};
pub use symbols::symbol_png;
pub use system::{
    cf_array_strings, executable_of, memory_footprint, peer_uid, time_since_boot, user_temp_dir,
};
pub use text::{
    TextServices, font_families, look_up, self_test_look_up_fonts, self_test_look_up_speech, speak,
};
pub use webkit::{
    keep_running_while_hidden, self_test_peer_connection_toggle, self_test_private_api_guards,
    self_test_resource_hints_off, self_test_sixty_fps_toggle, turn_off_peer_connections,
    turn_off_resource_hints, unlock_high_refresh_rate,
};
pub use window::{keep_glass_active, round_window_corner, self_test_glass_stays_active};

use objc2::msg_send;
use objc2::runtime::{AnyObject, Bool};

/// # Safety
/// `object` must be a valid Objective-C object.
unsafe fn responds(object: *mut AnyObject, selector: objc2::runtime::Sel) -> bool {
    // SAFETY: `object` is valid (caller contract); every NSObject responds to
    // respondsToSelector:.
    let answer: Bool = unsafe { msg_send![object, respondsToSelector: selector] };
    answer.as_bool()
}
