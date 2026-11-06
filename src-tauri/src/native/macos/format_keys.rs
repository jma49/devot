//! The Format menu's key equivalents: their priority over the web view and taking them away.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool};
use objc2::sel;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSBackingStoreType, NSEvent, NSEventMask, NSEventModifierFlags, NSMenu,
    NSWindow, NSWindowStyleMask,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use objc2_web_kit::{WKWebView, WKWebViewConfiguration};

use crate::native::{KeyDown, is_main_window, offers_to_format_menu};

use super::responds;

/// AppKit asks the key window's views for a key equivalent before the menu bar, and the web view
/// took Command-I in the editor without passing it on; a local event monitor runs before both. Only
/// the Format menu is asked, so every other key goes its usual way, and that menu has keys only
/// while the editor has the keyboard (`format_menu`). While an input method composes (marked text)
/// no key is offered. The windows it serves are the main windows `native::main_window_built` lists
/// (the Format menu acts on the frontmost one). Must run on the main thread; the monitor lives for
/// the rest of the process.
pub fn give_format_menu_keys_priority(menu_title: &'static str) {
    let Some(mtm) = MainThreadMarker::new() else {
        log::warn!("W_FORMAT_KEY_MONITOR_NOT_MAIN_THREAD");
        return;
    };
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit hands the monitor a live NSEvent for the duration
        // of the call.
        let key = unsafe { event.as_ref() };
        let taken = catch_unwind(AssertUnwindSafe(|| {
            offer_to_format_menu(mtm, menu_title, key)
        }))
        .unwrap_or(false);
        if taken {
            std::ptr::null_mut()
        } else {
            event.as_ptr()
        }
    });
    // SAFETY: the block returns either the event it was given or null, as
    // the handler contract requires; the block and the monitor are leaked,
    // so the handler lives as long as the process.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block)
    };
    if monitor.is_some() {
        log::info!("I_FORMAT_KEY_MONITOR_ON");
    } else {
        log::warn!("W_FORMAT_KEY_MONITOR_UNAVAILABLE");
    }
    std::mem::forget(monitor);
    std::mem::forget(block);
}

fn offer_to_format_menu(mtm: MainThreadMarker, menu_title: &str, event: &NSEvent) -> bool {
    let flags = event.modifierFlags();
    let which = |window: &Option<Retained<NSWindow>>| match window {
        None => WindowIs::None,
        Some(window) if is_main_window(Retained::as_ptr(window).cast()) => WindowIs::Main,
        Some(_) => WindowIs::Other,
    };
    let app = NSApplication::sharedApplication(mtm);
    let key_ns_window = app.keyWindow();
    let event_window = which(&event.window(mtm));
    let key_window = which(&key_ns_window);
    let command = flags.contains(NSEventModifierFlags::Command);
    let control = flags.contains(NSEventModifierFlags::Control);
    let key = KeyDown {
        command,
        control,
        in_main_window: event_window == WindowIs::Main,
        main_window_is_key: key_window == WindowIs::Main,
        // Asked only for keys with Command or Control, never while typing.
        marked_text: (command || control)
            && key_window == WindowIs::Main
            && key_ns_window.as_deref().is_some_and(has_marked_text),
    };
    let log = |outcome: &str, menu: Option<&NSMenu>| {
        #[cfg(debug_assertions)]
        if key.command || key.control {
            log_key_decision(outcome, key, event_window, key_window, event, menu);
        }
        #[cfg(not(debug_assertions))]
        let _ = (outcome, menu);
    };
    if !offers_to_format_menu(key) {
        log("NOT_OFFERED", None);
        return false;
    }
    let Some(menu) = format_menu(&app, menu_title) else {
        log("NO_MENU", None);
        return false;
    };
    let taken = menu.performKeyEquivalent(event);
    log(if taken { "TAKEN" } else { "REFUSED" }, Some(&menu));
    #[cfg(debug_assertions)]
    if taken {
        log::info!("I_FORMAT_KEY_MENU");
    }
    taken
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WindowIs {
    None = 0,
    Main = 1,
    Other = 2,
}

/// Logs, as codes and numbers only, the outcome (TAKEN, REFUSED: the menu said no; NOT_OFFERED: the
/// window check failed or an input method composes; NO_MENU: no Format menu), the event's window
/// and the key window (0 none, 1 main, 2 other), marked text, modifier bits, key code, auto-repeat,
/// and whether an item has this key by a plain comparison (0 none, 1 enabled, 2 disabled).
#[cfg(debug_assertions)]
fn log_key_decision(
    outcome: &str,
    key: KeyDown,
    event_window: WindowIs,
    key_window: WindowIs,
    event: &NSEvent,
    menu: Option<&NSMenu>,
) {
    let mods = event.modifierFlags() & NSEventModifierFlags::DeviceIndependentFlagsMask;
    let item = menu.map_or(0, |menu| match item_with_key(menu, event) {
        None => 0,
        Some(true) => 1,
        Some(false) => 2,
    });
    log::info!(
        "I_FORMAT_KEY_SEEN out={outcome} cmd={} ctrl={} win={} keywin={} marked={} mods={:#x} code={} repeat={} item={item}",
        u8::from(key.command),
        u8::from(key.control),
        event_window as u8,
        key_window as u8,
        u8::from(key.marked_text),
        mods.0,
        event.keyCode(),
        u8::from(event.isARepeat()),
    );
}

/// A diagnostic only; AppKit's own matching also knows keyboard layouts.
#[cfg(debug_assertions)]
fn item_with_key(menu: &NSMenu, event: &NSEvent) -> Option<bool> {
    let relevant = NSEventModifierFlags::Command
        | NSEventModifierFlags::Control
        | NSEventModifierFlags::Option
        | NSEventModifierFlags::Shift;
    let key = event
        .charactersIgnoringModifiers()?
        .to_string()
        .to_lowercase();
    let mods = event.modifierFlags() & relevant;
    menu.itemArray().iter().find_map(|item| {
        if let Some(submenu) = item.submenu() {
            return item_with_key(&submenu, event);
        }
        let matches = item.keyEquivalent().to_string().to_lowercase() == key
            && (item.keyEquivalentModifierMask() & relevant) == mods;
        matches.then(|| item.isEnabled())
    })
}

/// The menu library cannot take a key away (setting no accelerator leaves the old one), and AppKit
/// lets a disabled item with a key take that key without running, so the Format menu would swallow
/// its keys outside the editor. Must run on the main thread; false when the menu is missing.
pub fn clear_key_equivalents(menu_title: &str) -> bool {
    fn clear(menu: &NSMenu) {
        let empty = NSString::new();
        for item in menu.itemArray().iter() {
            match item.submenu() {
                Some(submenu) => clear(&submenu),
                None => item.setKeyEquivalent(&empty),
            }
        }
    }
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    catch_unwind(AssertUnwindSafe(|| {
        let app = NSApplication::sharedApplication(mtm);
        format_menu(&app, menu_title)
            .map(|menu| clear(&menu))
            .is_some()
    }))
    .unwrap_or(false)
}

/// The View menu's items that run a command lose their key when the user takes it away, and full
/// screen keeps its own. Must run on the main thread; false when the menu is missing.
pub fn clear_item_key_equivalents(menu_title: &str, item_titles: &[&str]) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    catch_unwind(AssertUnwindSafe(|| {
        let app = NSApplication::sharedApplication(mtm);
        let Some(menu) = format_menu(&app, menu_title) else {
            return false;
        };
        clear_titled_keys(&menu, item_titles);
        true
    }))
    .unwrap_or(false)
}

/// AppKit names the app menu after the process, so it is found by position, not title. Must run on
/// the main thread; false when it is missing.
pub fn clear_app_menu_key_equivalents(item_titles: &[&str]) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    catch_unwind(AssertUnwindSafe(|| {
        let app = NSApplication::sharedApplication(mtm);
        let Some(menu) = app
            .mainMenu()
            .and_then(|bar| bar.itemAtIndex(0))
            .and_then(|holder| holder.submenu())
        else {
            return false;
        };
        clear_titled_keys(&menu, item_titles);
        true
    }))
    .unwrap_or(false)
}

/// Clears the key of each item of `menu` (not a submenu holder) titled one
/// of `item_titles`.
fn clear_titled_keys(menu: &NSMenu, item_titles: &[&str]) {
    let empty = NSString::new();
    for item in menu.itemArray().iter() {
        let title = item.title().to_string();
        if item.submenu().is_none() && item_titles.contains(&title.as_str()) {
            item.setKeyEquivalent(&empty);
        }
    }
}

/// The Format menu as the menu bar holds it, found by its title on every
/// key: muda builds a separate NSMenu for each place a submenu is attached
/// (`Submenu::ns_menu` is its own copy, not the menu bar's), and the menu
/// bar can be replaced.
fn format_menu(app: &NSApplication, title: &str) -> Option<Retained<NSMenu>> {
    app.mainMenu()?
        .itemWithTitle(&NSString::from_str(title))?
        .submenu()
}

/// False when the responder cannot say: `hasMarkedText` belongs to NSTextInputClient, which not
/// every responder adopts.
fn has_marked_text(window: &NSWindow) -> bool {
    let Some(responder) = window.firstResponder() else {
        return false;
    };
    let responder = Retained::as_ptr(&responder).cast::<AnyObject>().cast_mut();
    // SAFETY: `responder` is the window's live first responder, retained
    // above for the duration of this call.
    if !unsafe { responds(responder, sel!(hasMarkedText)) } {
        return false;
    }
    // SAFETY: the responder implements `hasMarkedText` (checked above),
    // which takes no arguments and returns a BOOL (NSTextInputClient).
    let marked: Bool = unsafe { msg_send![responder, hasMarkedText] };
    marked.as_bool()
}

/// AppKit wants the main thread, so it refuses to run anywhere else.
#[doc(hidden)]
pub fn self_test_format_menu_keys() -> Result<(), &'static str> {
    use objc2_app_kit::{NSEventType, NSMenuItem};
    use objc2_foundation::{NSMutableArray, NSObject, NSPoint};

    const TITLE: &str = "Format";
    let mtm = MainThreadMarker::new().ok_or("E_NATIVE_NOT_MAIN_THREAD")?;
    let app = NSApplication::sharedApplication(mtm);
    let item = |key: &str, ran: &NSMutableArray<NSObject>| {
        let item = NSMenuItem::new(mtm);
        item.setKeyEquivalent(&NSString::from_str(key));
        item.setKeyEquivalentModifierMask(NSEventModifierFlags::Command);
        // SAFETY: `addObject:` takes one object argument, which the menu
        // passes (the item); the array outlives the menu bar it is used in.
        unsafe {
            item.setTarget(Some(ran));
            item.setAction(Some(sel!(addObject:)));
        }
        item
    };
    let submenu = |title: &str, item: &NSMenuItem| {
        let menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str(title));
        menu.setAutoenablesItems(false);
        menu.addItem(item);
        let holder = NSMenuItem::new(mtm);
        holder.setTitle(&NSString::from_str(title));
        holder.setSubmenu(Some(&menu));
        holder
    };
    let format_ran = NSMutableArray::<NSObject>::new();
    let edit_ran = NSMutableArray::<NSObject>::new();
    let format_italic = item("i", &format_ran);
    let edit_italic = item("i", &edit_ran);
    let nested_heading = item("1", &format_ran);
    let bar = NSMenu::new(mtm);
    bar.addItem(&submenu("Edit", &edit_italic));
    let format = submenu(TITLE, &format_italic);
    if let Some(menu) = format.submenu() {
        menu.addItem(&submenu("Heading", &nested_heading));
    }
    bar.addItem(&format);
    let key = |chars: &str, code: u16| {
        NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            NSEventType::KeyDown,
            NSPoint::new(0.0, 0.0),
            NSEventModifierFlags::Command,
            0.0,
            0,
            None,
            &NSString::from_str(chars),
            &NSString::from_str(chars),
            false,
            code,
        )
    };
    let command_i = key("i", 34).ok_or("E_NATIVE_EVENT_MISSING")?;
    let command_j = key("j", 38).ok_or("E_NATIVE_EVENT_MISSING")?;

    let previous = app.mainMenu();
    app.setMainMenu(Some(&bar));
    let result = (|| {
        let menu = format_menu(&app, TITLE).ok_or("E_FORMAT_MENU_NOT_FOUND")?;
        if format_menu(&app, "Nope").is_some() {
            return Err("E_FORMAT_MENU_FOUND_BY_OTHER_TITLE");
        }
        if !menu.performKeyEquivalent(&command_i) {
            return Err("E_FORMAT_KEY_NOT_TAKEN");
        }
        if format_ran.count() != 1 || edit_ran.count() != 0 {
            return Err("E_FORMAT_KEY_RAN_WRONG_ITEM");
        }
        if menu.performKeyEquivalent(&command_j) {
            return Err("E_FORMAT_KEY_TAKEN_WITHOUT_ITEM");
        }
        // A disabled item still takes its key (without running), which is
        // why the keys come off outside the editor.
        format_italic.setEnabled(false);
        if !menu.performKeyEquivalent(&command_i) || format_ran.count() != 1 {
            return Err("E_FORMAT_KEY_DISABLED_ITEM_CHANGED");
        }
        format_italic.setEnabled(true);
        if !clear_key_equivalents(TITLE) {
            return Err("E_FORMAT_KEYS_NOT_CLEARED");
        }
        if menu.performKeyEquivalent(&command_i) || format_ran.count() != 1 {
            return Err("E_FORMAT_KEY_TAKEN_WITHOUT_KEYS");
        }
        if nested_heading.keyEquivalent().length() != 0 || edit_italic.keyEquivalent().length() == 0
        {
            return Err("E_FORMAT_KEYS_CLEARED_WRONG_ITEMS");
        }
        let kept = item("k", &edit_ran);
        kept.setTitle(&NSString::from_str("Kept"));
        let named = item("j", &edit_ran);
        named.setTitle(&NSString::from_str("Named"));
        let edit = app
            .mainMenu()
            .and_then(|bar| bar.itemWithTitle(&NSString::from_str("Edit")))
            .and_then(|holder| holder.submenu())
            .ok_or("E_EDIT_MENU_NOT_FOUND")?;
        edit.addItem(&kept);
        edit.addItem(&named);
        if !clear_item_key_equivalents("Edit", &["Named", "Missing"])
            || clear_item_key_equivalents("Nope", &["Named"])
        {
            return Err("E_ITEM_KEYS_NOT_CLEARED");
        }
        if named.keyEquivalent().length() != 0
            || kept.keyEquivalent().length() == 0
            || edit_italic.keyEquivalent().length() == 0
        {
            return Err("E_ITEM_KEYS_CLEARED_WRONG_ITEMS");
        }
        let first = app
            .mainMenu()
            .and_then(|bar| bar.itemAtIndex(0))
            .and_then(|holder| holder.submenu())
            .ok_or("E_APP_MENU_NOT_FOUND")?;
        let backups = item("b", &edit_ran);
        backups.setTitle(&NSString::from_str("Backups"));
        first.addItem(&backups);
        if !clear_app_menu_key_equivalents(&["Backups"]) || backups.keyEquivalent().length() != 0 {
            return Err("E_APP_MENU_KEY_NOT_CLEARED");
        }
        Ok(())
    })();
    app.setMainMenu(previous.as_deref());
    result
}

/// Checks on an offscreen window what the key monitor reads before it
/// offers a key: an input method's marked text in the first responder (a
/// text view, which answers as the web view does) until it is committed,
/// none from a responder that cannot say, and that the web view answers.
/// AppKit wants the main thread, so it refuses to run anywhere else.
#[doc(hidden)]
pub fn self_test_marked_text() -> Result<(), &'static str> {
    use objc2_app_kit::{NSResponder, NSTextInputClient, NSTextView, NSView};
    use objc2_foundation::{NSNotFound, NSRange};

    let mtm = MainThreadMarker::new().ok_or("E_NATIVE_NOT_MAIN_THREAD")?;
    let _app = NSApplication::sharedApplication(mtm);
    let rect = NSRect::new(
        NSPoint::new(-20_000.0, -20_000.0),
        NSSize::new(400.0, 300.0),
    );
    // SAFETY: a fresh allocation with a valid style, backing and frame.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            rect,
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: the window is owned here; AppKit must not release it on close.
    unsafe { window.setReleasedWhenClosed(false) };
    let result = (|| {
        window.makeFirstResponder(None);
        if has_marked_text(&window) {
            return Err("E_MARKED_TEXT_WITHOUT_CLIENT");
        }
        let text = NSTextView::initWithFrame(NSTextView::alloc(mtm), rect);
        let view: &NSView = &text;
        window.setContentView(Some(view));
        let responder: &NSResponder = &text;
        if !window.makeFirstResponder(Some(responder)) {
            return Err("E_MARKED_TEXT_NOT_FIRST_RESPONDER");
        }
        if has_marked_text(&window) {
            return Err("E_MARKED_TEXT_BEFORE_COMPOSING");
        }
        let replace_nothing = NSRange::new(NSNotFound as usize, 0);
        // SAFETY: the string is an NSString, as the method expects; the
        // selection lies within it and NSNotFound means no replacement.
        unsafe {
            text.setMarkedText_selectedRange_replacementRange(
                &NSString::from_str("ni"),
                NSRange::new(2, 0),
                replace_nothing,
            );
        }
        if !has_marked_text(&window) {
            return Err("E_MARKED_TEXT_NOT_SEEN");
        }
        text.unmarkText();
        if has_marked_text(&window) {
            return Err("E_MARKED_TEXT_AFTER_COMMIT");
        }
        // SAFETY: a fresh configuration, made on the main thread.
        let config = unsafe { WKWebViewConfiguration::new(mtm) };
        // SAFETY: a fresh allocation with a valid frame and configuration.
        let web_view =
            unsafe { WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), rect, &config) };
        let view: &NSView = &web_view;
        window.setContentView(Some(view));
        let responder: &NSResponder = &web_view;
        if !window.makeFirstResponder(Some(responder)) {
            return Err("E_MARKED_TEXT_WEB_VIEW_NOT_FIRST_RESPONDER");
        }
        let web_view_object = Retained::as_ptr(&web_view).cast::<AnyObject>().cast_mut();
        // SAFETY: `web_view_object` is the live web view retained above.
        if !unsafe { responds(web_view_object, sel!(hasMarkedText)) } {
            return Err("E_MARKED_TEXT_WEB_VIEW_CANNOT_SAY");
        }
        if has_marked_text(&window) {
            return Err("E_MARKED_TEXT_IN_IDLE_WEB_VIEW");
        }
        Ok(())
    })();
    window.close();
    result
}
