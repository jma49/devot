//! macOS-only native code: AppKit and WebKit calls through objc2, and the C
//! library calls the standard library has no safe form for.
//!
//! Every private API call is guarded by `respondsToSelector:` (and every
//! object it returns by its class) and runs inside `guarded`, which catches
//! an Objective-C exception as well as a Rust panic: `catch_unwind` alone
//! cannot stop an Objective-C exception, which would end the app. When an API
//! is missing or fails, the app keeps its default behaviour and logs a code.

use std::panic::{AssertUnwindSafe, catch_unwind};

use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::sel;
use objc2::{AllocAnyThread, ClassType, msg_send};
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSFontWeightRegular, NSImage,
    NSImageSymbolConfiguration, NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeString,
    NSPasteboardTypeTIFF,
};
use objc2_foundation::{NSData, NSDictionary, NSString};
use tauri::Manager;

/// WebKit feature that paces page rendering updates near 60 fps by default,
/// even on 120 Hz displays.
const SIXTY_FPS_FEATURE: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";

/// Runs `call`, which sends private messages, so that nothing it throws gets
/// out: an Objective-C exception (which `catch_unwind` cannot stop; it would
/// end the app) and a Rust panic are both caught, logged as `code` and give
/// `None`, the caller's fallback.
fn guarded<R>(code: &'static str, call: impl FnOnce() -> Option<R>) -> Option<R> {
    let caught = catch_unwind(AssertUnwindSafe(|| {
        objc2::exception::catch(AssertUnwindSafe(call))
    }));
    match caught {
        Ok(Ok(result)) => result,
        Ok(Err(_exception)) => {
            log::warn!("{code} E_NATIVE_OBJC_EXCEPTION");
            None
        }
        Err(_panic) => {
            log::warn!("{code} E_NATIVE_PANIC");
            None
        }
    }
}

/// Lets the main webview render at the display's refresh rate.
pub fn unlock_high_refresh_rate(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("E_NATIVE_MAIN_WINDOW_MISSING");
        return;
    };
    let result = window.with_webview(|webview| {
        let unlocked = guarded("W_NATIVE_HIGH_REFRESH_RATE_FAILED", || {
            // SAFETY: `inner()` is the live WKWebView owned by this window;
            // every selector is checked with respondsToSelector: before use.
            unsafe { disable_sixty_fps_feature(webview.inner().cast()) }.then_some(())
        })
        .is_some();
        if unlocked {
            log::info!("I_NATIVE_HIGH_REFRESH_RATE_ON");
        } else {
            log::warn!("W_NATIVE_HIGH_REFRESH_RATE_UNAVAILABLE");
        }
    });
    if result.is_err() {
        log::warn!("W_NATIVE_WEBVIEW_UNAVAILABLE");
    }
}

/// # Safety
/// `web_view` must point to a live `WKWebView`.
unsafe fn disable_sixty_fps_feature(web_view: *mut AnyObject) -> bool {
    if web_view.is_null() {
        return false;
    }
    // SAFETY: `web_view` is a live WKWebView (caller contract). WKWebView
    // responds to `configuration`, which responds to `preferences`.
    let preferences: *mut AnyObject = unsafe {
        let configuration: *mut AnyObject = msg_send![web_view, configuration];
        if configuration.is_null() {
            return false;
        }
        msg_send![configuration, preferences]
    };
    // SAFETY: `preferences` is null or a live WKPreferences.
    unsafe { set_sixty_fps_feature(preferences, false) }
}

/// Finds WebKit's private `_WKFeature` object for the 60 fps preference.
fn sixty_fps_feature() -> Option<*mut AnyObject> {
    let class = AnyClass::get(c"WKPreferences")?;
    // `_features` is a class method, so ask the class object itself;
    // `AnyClass::responds_to` only answers for instance methods.
    let class_object = std::ptr::from_ref(class).cast::<AnyObject>().cast_mut();
    // SAFETY: a class object is a valid Objective-C object.
    if !unsafe { responds(class_object, sel!(_features)) } {
        return None;
    }
    // SAFETY: `_features` exists (checked above) and returns an NSArray of
    // _WKFeature objects.
    unsafe {
        let features: *mut AnyObject = msg_send![class, _features];
        find_feature(features, SIXTY_FPS_FEATURE)
    }
}

/// The feature in `features` whose `key` is `key`. WebKit's private objects
/// can change in any update, so each message is sent only to an object that
/// answers it (`respondsToSelector:`) and the key is read only when it is a
/// string; anything else is skipped, never sent a message it would throw on.
///
/// # Safety
/// `features` must be null or a live Objective-C object.
unsafe fn find_feature(features: *mut AnyObject, key: &str) -> Option<*mut AnyObject> {
    // SAFETY: `features` is null or live (caller contract); `count` and
    // `objectAtIndex:` are sent only when it answers both.
    let count: usize = unsafe {
        if features.is_null()
            || !responds(features, sel!(count))
            || !responds(features, sel!(objectAtIndex:))
        {
            return None;
        }
        msg_send![features, count]
    };
    (0..count).find_map(|index| {
        // SAFETY: an index below `count` of the list checked above; each
        // element is a live object the list holds. `key` is sent only to an
        // element that answers it, and its answer is read as a string only
        // when it is one.
        unsafe {
            let feature: *mut AnyObject = msg_send![features, objectAtIndex: index];
            if feature.is_null() || !responds(feature, sel!(key)) {
                return None;
            }
            let name: *mut AnyObject = msg_send![feature, key];
            if name.is_null() || !is_kind_of(name, NSString::class()) {
                return None;
            }
            ((*name.cast::<NSString>()).to_string() == key).then_some(feature)
        }
    })
}

/// # Safety
/// `object` must be a valid Objective-C object.
unsafe fn is_kind_of(object: *mut AnyObject, class: &AnyClass) -> bool {
    // SAFETY: `object` is valid (caller contract); every NSObject responds
    // to isKindOfClass:.
    let answer: Bool = unsafe { msg_send![object, isKindOfClass: class] };
    answer.as_bool()
}

/// Checks the private API guards on objects that stand in for WebKit's: a
/// list whose objects lost `key` gives no feature and no crash, and the one
/// whose `key` matches is found. Run on the main thread
/// (`tests/main_thread.rs`).
#[doc(hidden)]
pub fn self_test_private_api_guards() -> Result<(), &'static str> {
    use objc2::runtime::NSObject;
    use objc2_foundation::NSArray;
    let sort_descriptor = |key: Option<&str>| -> Result<Retained<AnyObject>, &'static str> {
        let class = AnyClass::get(c"NSSortDescriptor").ok_or("E_NATIVE_FOUNDATION_MISSING")?;
        let key = key.map(NSString::from_str);
        // SAFETY: a public Foundation class method (macOS 10.6+) taking a
        // string or nil and a BOOL; it returns an autoreleased descriptor,
        // which `Retained` takes a reference to.
        unsafe {
            let made: Option<Retained<AnyObject>> = msg_send![
                class,
                sortDescriptorWithKey: key.as_deref(),
                ascending: Bool::YES
            ];
            made.ok_or("E_NATIVE_SORT_DESCRIPTOR_MISSING")
        }
    };
    // Objects that answer no `key`, as WebKit's could after an update.
    let without_key: Vec<Retained<NSObject>> = (0..3).map(|_| NSObject::new()).collect();
    let refs: Vec<&AnyObject> = without_key.iter().map(|o| &***o).collect();
    let array = NSArray::<AnyObject>::from_slice(&refs);
    let array_ptr = Retained::as_ptr(&array).cast_mut().cast::<AnyObject>();
    // SAFETY: `array` is a live NSArray for the whole call.
    if unsafe { find_feature(array_ptr, SIXTY_FPS_FEATURE) }.is_some() {
        return Err("E_NATIVE_FOUND_A_FEATURE_IN_PLAIN_OBJECTS");
    }
    // Objects that answer `key`: a nil key, another key, the one looked for.
    let unnamed = sort_descriptor(None)?;
    let other = sort_descriptor(Some("Other"))?;
    let wanted = sort_descriptor(Some(SIXTY_FPS_FEATURE))?;
    let objects: [&AnyObject; 4] = [&without_key[0], &unnamed, &other, &wanted];
    let array = NSArray::<AnyObject>::from_slice(&objects);
    let array_ptr = Retained::as_ptr(&array).cast_mut().cast::<AnyObject>();
    // SAFETY: `array` is a live NSArray for the whole call.
    let found = unsafe { find_feature(array_ptr, SIXTY_FPS_FEATURE) };
    if found != Some(Retained::as_ptr(&wanted).cast_mut()) {
        return Err("E_NATIVE_FEATURE_NOT_FOUND_BY_KEY");
    }
    // A list that is not one (as `_features` could return) gives nothing.
    let not_a_list = Retained::as_ptr(&wanted).cast_mut();
    // SAFETY: a live object, which is all `find_feature` needs.
    if unsafe { find_feature(not_a_list, SIXTY_FPS_FEATURE) }.is_some() {
        return Err("E_NATIVE_FOUND_A_FEATURE_IN_A_NON_LIST");
    }
    // An Objective-C exception inside a guarded call (here an index past the
    // end of a list) gives the fallback; unguarded, it would end the app.
    let thrown = guarded("W_NATIVE_SELF_TEST_EXCEPTION", || {
        // SAFETY: deliberately out of range, so NSArray throws
        // NSRangeException, which `guarded` catches.
        let _: *mut AnyObject = unsafe { msg_send![&*array, objectAtIndex: 99usize] };
        Some(())
    });
    if thrown.is_some() {
        return Err("E_NATIVE_EXCEPTION_NOT_CAUGHT");
    }
    Ok(())
}

/// Turns the 60 fps preference on or off. Returns false when WebKit does not
/// offer it.
///
/// # Safety
/// `preferences` must be null or a live `WKPreferences`.
unsafe fn set_sixty_fps_feature(preferences: *mut AnyObject, enabled: bool) -> bool {
    if preferences.is_null()
        // SAFETY: `preferences` is a non-null WKPreferences (caller contract).
        || !unsafe { responds(preferences, sel!(_setEnabled:forFeature:)) }
    {
        return false;
    }
    let Some(feature) = sixty_fps_feature() else {
        return false;
    };
    // SAFETY: the selector exists (checked above) and `feature` is a
    // _WKFeature returned by WebKit.
    let _: () =
        unsafe { msg_send![preferences, _setEnabled: Bool::new(enabled), forFeature: feature] };
    true
}

/// # Safety
/// `object` must be a valid Objective-C object.
unsafe fn responds(object: *mut AnyObject, selector: objc2::runtime::Sel) -> bool {
    // SAFETY: `object` is valid (caller contract); every NSObject responds to
    // respondsToSelector:.
    let answer: Bool = unsafe { msg_send![object, respondsToSelector: selector] };
    answer.as_bool()
}

/// Renders an SF Symbol to PNG bytes at twice `point_size` pixels. Safe off
/// the main thread, one call at a time (`native::render_one_at_a_time`);
/// AppKit's temporaries go in an autorelease pool of the call's own, as a
/// blocking thread has none to empty.
pub fn symbol_png(name: &str, point_size: f64) -> Option<Vec<u8>> {
    catch_unwind(|| {
        objc2::rc::autoreleasepool(|_| {
            // SAFETY: these are public AppKit APIs (macOS 11+) called with
            // valid, owned arguments; every result is checked for nil.
            unsafe {
                let image = NSImage::imageWithSystemSymbolName_accessibilityDescription(
                    &NSString::from_str(name),
                    None,
                )?;
                let configuration = NSImageSymbolConfiguration::configurationWithPointSize_weight(
                    point_size * 2.0,
                    NSFontWeightRegular,
                );
                let image = image.imageWithSymbolConfiguration(&configuration)?;
                let tiff = image.TIFFRepresentation()?;
                let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)?;
                let png = bitmap.representationUsingType_properties(
                    NSBitmapImageFileType::PNG,
                    &NSDictionary::new(),
                )?;
                Some(png.to_vec())
            }
        })
    })
    .ok()
    .flatten()
}

/// Replaces the general pasteboard's contents with plain text.
pub fn write_clipboard_text(text: &str) -> bool {
    catch_unwind(|| {
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        // SAFETY: `NSPasteboardTypeString` is an immutable AppKit constant
        // (macOS 10.6+), valid for the life of the process.
        let kind = unsafe { NSPasteboardTypeString };
        pasteboard.setString_forType(&NSString::from_str(text), kind)
    })
    .unwrap_or(false)
}

/// An image ready for the pasteboard: PNG data (when it could be made) and
/// TIFF data, the two types other apps paste.
pub struct PasteboardImage {
    pub png: Option<Vec<u8>>,
    pub tiff: Vec<u8>,
}

/// Decodes an attachment into the data the pasteboard gets. A PNG keeps its
/// own bytes; other formats are converted. Safe off the main thread (NSImage
/// and NSBitmapImageRep decode on any thread), so the work never stalls the
/// UI. `E_IMAGE_UNREADABLE` when AppKit cannot read the bytes as an image,
/// `E_IMAGE_TOO_LARGE` when its header gives it more than `max_pixels`
/// pixels: nothing is decoded then.
///
/// AppKit's temporaries (several decoded copies of the image) go in an
/// autorelease pool of the call's own, emptied before it returns: a thread
/// with no pool keeps them until it exits, and a blocking-pool thread lives
/// on for 10 s and more, so a few copies of a large photo held hundreds of
/// MB. What is returned is Rust's own copy.
pub fn pasteboard_image(bytes: &[u8], max_pixels: u64) -> Result<PasteboardImage, &'static str> {
    catch_unwind(AssertUnwindSafe(|| {
        objc2::rc::autoreleasepool(|_| {
            let data = NSData::with_bytes(bytes);
            // The size, read from the header without decoding the pixels.
            let header = NSBitmapImageRep::imageRepWithData(&data).ok_or("E_IMAGE_UNREADABLE")?;
            let side = |n: isize| u64::try_from(n).unwrap_or(0);
            if side(header.pixelsWide()).saturating_mul(side(header.pixelsHigh())) > max_pixels {
                return Err("E_IMAGE_TOO_LARGE");
            }
            let image =
                NSImage::initWithData(NSImage::alloc(), &data).ok_or("E_IMAGE_UNREADABLE")?;
            let tiff = image.TIFFRepresentation().ok_or("E_IMAGE_UNREADABLE")?;
            let png = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                Some(bytes.to_vec())
            } else {
                NSBitmapImageRep::imageRepWithData(&tiff).and_then(|bitmap| {
                    // SAFETY: a public AppKit API (macOS 10.0+) called on a
                    // live bitmap with an empty properties dictionary; nil
                    // is checked.
                    unsafe {
                        bitmap.representationUsingType_properties(
                            NSBitmapImageFileType::PNG,
                            &NSDictionary::new(),
                        )
                    }
                    .map(|png| png.to_vec())
                })
            };
            Ok(PasteboardImage {
                png,
                tiff: tiff.to_vec(),
            })
        })
    }))
    .unwrap_or(Err("E_IMAGE_UNREADABLE"))
}

/// Replaces a pasteboard's contents with an image. False when nothing could
/// be written. Run on the main thread.
pub fn write_image(pasteboard: &NSPasteboard, image: &PasteboardImage) -> bool {
    catch_unwind(AssertUnwindSafe(|| {
        pasteboard.clearContents();
        // SAFETY: both types are immutable AppKit constants (macOS 10.6+),
        // valid for the life of the process.
        let (png_type, tiff_type) = unsafe { (NSPasteboardTypePNG, NSPasteboardTypeTIFF) };
        let wrote_png = image.png.as_ref().is_some_and(|png| {
            pasteboard.setData_forType(Some(&NSData::with_bytes(png)), png_type)
        });
        let wrote_tiff =
            pasteboard.setData_forType(Some(&NSData::with_bytes(&image.tiff)), tiff_type);
        wrote_png || wrote_tiff
    }))
    .unwrap_or(false)
}

/// Replaces the general pasteboard's contents with an image (see `write_image`).
pub fn write_clipboard_image(image: &PasteboardImage) -> bool {
    write_image(&NSPasteboard::generalPasteboard(), image)
}

/// Checks the image pasteboard path on a private pasteboard (the user's
/// clipboard is left alone): a PNG decoded on another thread goes on as PNG
/// (its own bytes) and TIFF, and bytes that are not an image are refused.
/// Run on the main thread.
pub fn self_test_image_pasteboard(png: &[u8]) -> Result<(), &'static str> {
    let owned = png.to_vec();
    let image = std::thread::spawn(move || pasteboard_image(&owned, u64::MAX))
        .join()
        .map_err(|_| "E_IMAGE_DECODE_PANICKED")?
        .map_err(|_| "E_IMAGE_NOT_DECODED")?;
    if image.png.as_deref() != Some(png) {
        return Err("E_IMAGE_PNG_NOT_KEPT");
    }
    if pasteboard_image(b"not an image", u64::MAX).is_ok() {
        return Err("E_IMAGE_TOOK_NON_IMAGE");
    }
    let pasteboard = NSPasteboard::pasteboardWithUniqueName();
    let result = (|| {
        if !write_image(&pasteboard, &image) {
            return Err("E_IMAGE_PASTEBOARD_NOT_WRITTEN");
        }
        // SAFETY: immutable AppKit constants, as above.
        let (png_type, tiff_type) = unsafe { (NSPasteboardTypePNG, NSPasteboardTypeTIFF) };
        let png_back = pasteboard
            .dataForType(png_type)
            .ok_or("E_IMAGE_PASTEBOARD_NO_PNG")?;
        if png_back.to_vec() != png {
            return Err("E_IMAGE_PASTEBOARD_BAD_PNG");
        }
        pasteboard
            .dataForType(tiff_type)
            .ok_or("E_IMAGE_PASTEBOARD_NO_TIFF")?;
        Ok(())
    })();
    let object: &AnyObject = &pasteboard;
    // SAFETY: `object` is a live NSPasteboard; the selector is checked
    // before it is sent, and it takes no arguments and returns nothing.
    unsafe {
        if responds(
            object as *const AnyObject as *mut AnyObject,
            sel!(releaseGlobally),
        ) {
            let _: () = msg_send![object, releaseGlobally];
        }
    }
    result
}

/// This process's physical memory footprint in bytes, as Activity Monitor
/// shows it; None when the kernel does not answer. The main-thread tests
/// read it to check that native work frees what it used.
#[doc(hidden)]
pub fn memory_footprint() -> Option<u64> {
    use mach2::task_info::{TASK_VM_INFO, task_vm_info};
    let mut info = task_vm_info::default();
    let mut count = (size_of::<task_vm_info>() / size_of::<mach2::vm_types::natural_t>())
        as mach2::message::mach_msg_type_number_t;
    // SAFETY: `task_info` writes at most `count` naturals (the size of
    // `info`, a plain struct that lives for the whole call) into `info` and
    // the number written into `count`; the task port is this process's own.
    let result = unsafe {
        mach2::task::task_info(
            mach2::traps::mach_task_self(),
            TASK_VM_INFO,
            (&raw mut info).cast(),
            &raw mut count,
        )
    };
    (result == mach2::kern_return::KERN_SUCCESS).then_some(info.phys_footprint)
}

/// The general pasteboard's plain text: `Ok(None)` when it holds none, an
/// error code when AppKit failed.
pub fn read_clipboard_text() -> Result<Option<String>, &'static str> {
    catch_unwind(|| {
        let pasteboard = NSPasteboard::generalPasteboard();
        // SAFETY: `NSPasteboardTypeString` is an immutable AppKit constant
        // (macOS 10.6+), valid for the life of the process.
        let kind = unsafe { NSPasteboardTypeString };
        pasteboard.stringForType(kind).map(|text| text.to_string())
    })
    .map_err(|_| "E_CLIPBOARD_READ_FAILED")
}

/// Reads the 60 fps preference back, if WebKit exposes it.
///
/// # Safety
/// `preferences` must be a live `WKPreferences`.
unsafe fn sixty_fps_enabled(preferences: *mut AnyObject) -> Option<bool> {
    let feature = sixty_fps_feature()?;
    // SAFETY: `preferences` is live (caller contract); the selector is
    // checked before the call.
    unsafe {
        if !responds(preferences, sel!(_isEnabledForFeature:)) {
            return None;
        }
        let enabled: Bool = msg_send![preferences, _isEnabledForFeature: feature];
        Some(enabled.as_bool())
    }
}

/// Checks on a throwaway `WKPreferences` that the 60 fps preference can be
/// found, turned off and turned back on. WebKit kills the process when this
/// runs off the main thread, so it refuses to.
#[doc(hidden)]
pub fn self_test_sixty_fps_toggle() -> Result<(), &'static str> {
    if objc2::MainThreadMarker::new().is_none() {
        return Err("E_NATIVE_NOT_MAIN_THREAD");
    }
    // Regression: `_features` is a class method; checking it as an instance
    // method silently left every window at 60 fps.
    sixty_fps_feature().ok_or("E_NATIVE_FEATURE_MISSING")?;
    let class = AnyClass::get(c"WKPreferences").ok_or("E_NATIVE_WEBKIT_MISSING")?;
    // SAFETY: `+new` returns an owned, live WKPreferences, released below;
    // the private calls run guarded, as the app runs them.
    unsafe {
        let preferences: *mut AnyObject = msg_send![class, new];
        let result = guarded("W_NATIVE_SELF_TEST_FAILED", || {
            Some(if !set_sixty_fps_feature(preferences, false) {
                Err("E_NATIVE_SET_OFF_FAILED")
            } else if sixty_fps_enabled(preferences) != Some(false) {
                Err("E_NATIVE_STILL_ON")
            } else if !set_sixty_fps_feature(preferences, true) {
                Err("E_NATIVE_SET_ON_FAILED")
            } else if sixty_fps_enabled(preferences) != Some(true) {
                Err("E_NATIVE_STILL_OFF")
            } else {
                Ok(())
            })
        })
        .unwrap_or(Err("E_NATIVE_TOGGLE_THREW"));
        let _: () = msg_send![preferences, release];
        result
    }
}

// ---- System accent colour --------------------------------------------------

use super::{AccentInfo, hex_from_unit_rgb};
use block2::RcBlock;
use objc2_app_kit::{
    NSAppearance, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSColor, NSColorSpace,
};
use objc2_foundation::{
    NSDistributedNotificationCenter, NSNotification, NSOperationQueue, NSUserDefaults,
};
use std::cell::Cell;
use std::ptr::NonNull;

/// macOS stores no `AppleAccentColor` value when the user picked Multicolor.
fn accent_is_multicolor() -> bool {
    NSUserDefaults::standardUserDefaults()
        .objectForKey(&NSString::from_str("AppleAccentColor"))
        .is_none()
}

/// The control accent colour as sRGB hex, resolved under `appearance`.
fn accent_hex_under(appearance: &NSAppearance) -> Option<String> {
    let result = Cell::new(None);
    let resolve =
        RcBlock::new(|| {
            let color = NSColor::controlAccentColor();
            let srgb = color.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace());
            result.set(srgb.map(|c| {
                hex_from_unit_rgb(c.redComponent(), c.greenComponent(), c.blueComponent())
            }));
        });
    appearance.performAsCurrentDrawingAppearance(&resolve);
    result.take()
}

/// Reads the system accent for both appearances. Must run on the main thread.
pub fn system_accent() -> AccentInfo {
    catch_unwind(|| {
        if accent_is_multicolor() {
            return AccentInfo::multicolor();
        }
        // SAFETY: the appearance names are static NSString constants exported
        // by AppKit.
        let (light_name, dark_name) = unsafe { (NSAppearanceNameAqua, NSAppearanceNameDarkAqua) };
        let light = NSAppearance::appearanceNamed(light_name).and_then(|a| accent_hex_under(&a));
        let dark = NSAppearance::appearanceNamed(dark_name).and_then(|a| accent_hex_under(&a));
        match (light, dark) {
            (Some(light), Some(dark)) => AccentInfo::system(light, dark),
            _ => AccentInfo::multicolor(),
        }
    })
    .unwrap_or_else(|_| AccentInfo::multicolor())
}

/// Calls `on_change` on the main thread whenever the user changes the accent
/// colour in System Settings. The observer lives for the rest of the process.
pub fn observe_accent_changes(on_change: impl Fn() + 'static) {
    let block = RcBlock::new(move |_note: NonNull<NSNotification>| on_change());
    let center = NSDistributedNotificationCenter::defaultCenter();
    // SAFETY: the name is a valid NSString, the main queue is a valid
    // operation queue, and the block outlives the observer (both leak).
    let observer = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(&NSString::from_str(
                "AppleColorPreferencesChangedNotification",
            )),
            None,
            Some(&NSOperationQueue::mainQueue()),
            &block,
        )
    };
    std::mem::forget(observer);
    std::mem::forget(block);
}

// ---- Format menu keys --------------------------------------------------------

use objc2::MainThreadMarker;
use objc2::rc::{Retained, Weak};
use objc2_app_kit::{NSApplication, NSEvent, NSEventMask, NSEventModifierFlags, NSMenu, NSWindow};

/// Offers every key-down with Command or Control in the main window to the
/// Format menu before anything else sees it, and swallows the keys the menu
/// takes. AppKit asks the key window's views for a key equivalent before
/// the menu bar, and the web view took Command-I in the editor without
/// passing it on; a local event monitor runs before both. Only the
/// Format menu is asked, so every other key goes its usual way, and that
/// menu has keys only while the editor has the keyboard (`format_menu`).
/// While an input method composes (marked text), no key is offered: the
/// web view hands it to the input method first. Must run on the main
/// thread after the main window exists; the monitor lives for the rest of
/// the process.
pub fn give_format_menu_keys_priority(app: &tauri::App, menu_title: &'static str) {
    let Some(mtm) = MainThreadMarker::new() else {
        log::warn!("W_FORMAT_KEY_MONITOR_NOT_MAIN_THREAD");
        return;
    };
    let main_window = app
        .get_webview_window("main")
        .and_then(|window| window.ns_window().ok())
        .filter(|window| !window.is_null());
    let Some(main_window) = main_window else {
        log::warn!("W_FORMAT_KEY_MONITOR_NO_WINDOW");
        return;
    };
    // SAFETY: `ns_window()` returns the live NSWindow of the main window
    // (checked non-null above); the weak reference does not keep it alive.
    let main_window: Weak<NSWindow> = Weak::new(unsafe { &*main_window.cast::<NSWindow>() });
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit hands the monitor a live NSEvent for the duration
        // of the call.
        let key = unsafe { event.as_ref() };
        let taken = catch_unwind(AssertUnwindSafe(|| {
            offer_to_format_menu(mtm, &main_window, menu_title, key)
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

/// Hands a key-down to the Format menu when `offers_to_format_menu` says
/// so; true when an item of the menu took it (and ran).
fn offer_to_format_menu(
    mtm: MainThreadMarker,
    main_window: &Weak<NSWindow>,
    menu_title: &str,
    event: &NSEvent,
) -> bool {
    let flags = event.modifierFlags();
    let main_window = main_window.load();
    let which = |window: Option<Retained<NSWindow>>| match (&window, &main_window) {
        (None, _) => WindowIs::None,
        (Some(window), Some(main)) if std::ptr::eq(&**window, &**main) => WindowIs::Main,
        (Some(_), _) => WindowIs::Other,
    };
    let app = NSApplication::sharedApplication(mtm);
    let event_window = which(event.window(mtm));
    let key_window = which(app.keyWindow());
    let command = flags.contains(NSEventModifierFlags::Command);
    let control = flags.contains(NSEventModifierFlags::Control);
    let key = super::KeyDown {
        command,
        control,
        in_main_window: event_window == WindowIs::Main,
        main_window_is_key: key_window == WindowIs::Main,
        // Asked only for keys with Command or Control, never while typing.
        marked_text: (command || control) && main_window.as_deref().is_some_and(has_marked_text),
    };
    let log = |outcome: &str, menu: Option<&NSMenu>| {
        #[cfg(debug_assertions)]
        if key.command || key.control {
            log_key_decision(outcome, key, event_window, key_window, event, menu);
        }
        #[cfg(not(debug_assertions))]
        let _ = (outcome, menu);
    };
    if !super::offers_to_format_menu(key) {
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

/// Which window an event or the key window is, for the debug log.
#[derive(Clone, Copy, PartialEq, Eq)]
enum WindowIs {
    None = 0,
    Main = 1,
    Other = 2,
}

/// Logs what the key monitor decided for a key with Command or Control, as
/// codes and numbers only (debug builds): the outcome (TAKEN, REFUSED: the
/// menu said no; NOT_OFFERED: the window check failed or an input method
/// composes; NO_MENU: the menu bar has no Format menu), the event's window
/// and the key window (0 none, 1 main, 2 other), whether the main window
/// has marked text, the device-independent modifier bits, the key code,
/// auto-repeat, and whether an item of the menu has this key by a plain
/// comparison (`item`: 0 none, 1 enabled, 2 disabled).
#[cfg(debug_assertions)]
fn log_key_decision(
    outcome: &str,
    key: super::KeyDown,
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

/// Whether an item of `menu` (or its submenus) has the event's key and
/// modifiers, compared plainly (the key ignoring modifiers, case folded):
/// `Some(enabled)` for the first such item. A diagnostic only; AppKit's own
/// matching also knows keyboard layouts.
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

/// Takes every key equivalent off the menu bar's menu titled `menu_title`
/// and its submenus. The menu library cannot take a key away (setting no
/// accelerator leaves the old one), and AppKit lets a disabled item with a
/// key take that key without running, so the Format menu would swallow its
/// keys outside the editor. Must run on the main thread; false when the
/// menu is missing.
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

/// Takes the key equivalents off the items titled one of `item_titles` in
/// the menu bar's menu titled `menu_title` (not its submenus), leaving its
/// other items alone: the View menu's items that run a command lose their
/// key when the user takes it away, and full screen keeps its own. Must run
/// on the main thread; false when the menu is missing.
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

/// Like `clear_item_key_equivalents` for the app menu (Devot), the menu
/// bar's first menu: AppKit names it after the process, so it is found by
/// position, not title. Must run on the main thread; false when it is
/// missing.
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

/// Whether the window's first responder has marked text, that is, an input
/// method is composing in it (the web view answers for its focused field or
/// editor). False when the responder cannot say: `hasMarkedText` belongs to
/// NSTextInputClient, which not every responder adopts.
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

/// Checks on a throwaway menu bar that a Command key goes to the Format
/// menu's item that has it (and runs that item, not one with the same key
/// in another menu), that a key no item has is not taken, that a disabled
/// item still takes its key, and that clearing the keys (submenus too)
/// leaves the menu taking nothing. AppKit wants the main thread, so it
/// refuses to run anywhere else.
#[doc(hidden)]
pub fn self_test_format_menu_keys() -> Result<(), &'static str> {
    use objc2::MainThreadOnly;
    use objc2_app_kit::{NSEventType, NSMenuItem};
    use objc2_foundation::{NSMutableArray, NSObject, NSPoint};

    const TITLE: &str = "Format";
    let mtm = MainThreadMarker::new().ok_or("E_NATIVE_NOT_MAIN_THREAD")?;
    let app = NSApplication::sharedApplication(mtm);
    // An item records that it ran by adding itself to its array.
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
        // Off the editor the items have no keys, in submenus too.
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
        // Items picked by title lose their key; the menu's others keep theirs.
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
        // The app menu is the bar's first menu, found by position.
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
        // The window itself has the keyboard, and it has no say on text.
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
        // An input method composes "ni": marked until it commits.
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
        // The editor's web view answers the same question, with nothing
        // marked while no input method composes.
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

// ---- Printing and PDF --------------------------------------------------------

use objc2::runtime::ProtocolObject;
use objc2::{DefinedClass, MainThreadOnly, define_class};
use objc2_app_kit::{
    NSBackingStoreType, NSPrintInfo, NSPrintJobDisposition, NSPrintJobSavingURL, NSPrintOperation,
    NSPrintSaveJob, NSWindowStyleMask,
};
use objc2_foundation::{
    NSCopying, NSError, NSNumber, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSURL,
};
use objc2_web_kit::{WKNavigation, WKNavigationDelegate, WKWebView, WKWebViewConfiguration};
use std::cell::RefCell;

/// Where a printed page goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrintTarget {
    /// The print panel, as a sheet on the window.
    Printer,
    /// A PDF file at this path, written without a panel.
    Pdf(std::path::PathBuf),
}

impl PrintTarget {
    /// What the print operation's `success` flag means for this target. A
    /// print through the panel either printed or was cancelled there; a PDF
    /// has no panel to cancel, so a PDF that was not written failed.
    pub fn outcome(&self, success: bool) -> Result<bool, &'static str> {
        match (self, success) {
            (_, true) => Ok(true),
            (PrintTarget::Printer, false) => Ok(false),
            (PrintTarget::Pdf(_), false) => Err("E_EXPORT_PDF_FAILED"),
        }
    }
}

/// What a print job reports once it is over: whether it printed (false when
/// the user cancelled the panel), or an error code.
pub type PrintDone = Box<dyn FnOnce(Result<bool, &'static str>)>;

/// The page's layout width before printing lays it out for the paper
/// (US Letter's width in points).
const PRINT_VIEW_WIDTH: f64 = 612.0;
const PRINT_VIEW_HEIGHT: f64 = 792.0;
/// Paper margins, in points (half an inch).
const PRINT_MARGIN: f64 = 36.0;
/// How long a page may take to load (its `data:` images decoded) before
/// the job gives up, in seconds.
const PRINT_LOAD_TIMEOUT: f64 = 60.0;

/// What a printed page may load, whatever its own policy says: its inline
/// styles and `data:` images (attachments are put in as those), nothing
/// from elsewhere. So printing, like the preview, never fetches an image
/// from the web: no server learns that a note was printed, and no slow host
/// holds the job up. The UI gives its pages to print the same policy
/// (`PRINT_CSP` in src/core/htmlExport.ts).
pub const PRINT_POLICY: &str = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/// `html` as the print view loads it: a doctype, then the print policy as a
/// `<meta>` before anything of the page's (whose own doctype, if it starts
/// with one, gives way to this one). Nothing in the page comes before the
/// policy, so it applies to every load the page asks for, and the page's
/// own policy can only narrow it further (every policy applies).
pub fn with_print_policy(html: &str) -> String {
    const DOCTYPE: &str = "<!doctype html>";
    let page = match html.get(..DOCTYPE.len()) {
        Some(start) if start.eq_ignore_ascii_case(DOCTYPE) => &html[DOCTYPE.len()..],
        _ => html,
    };
    let meta = format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{PRINT_POLICY}\">");
    let mut out = String::with_capacity(DOCTYPE.len() + meta.len() + page.len());
    out.push_str(DOCTYPE);
    out.push_str(&meta);
    out.push_str(page);
    out
}

pub struct PrintJobState {
    target: PrintTarget,
    /// The page is still loading: its load starts printing, and a load
    /// failure ends the job. False once printing has begun (from then on
    /// only the print operation ends the job) or the job is over.
    loading: Cell<bool>,
    title: String,
    window: Weak<NSWindow>,
    done: RefCell<Option<PrintDone>>,
    web_view: RefCell<Option<Retained<WKWebView>>>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and `PrintJob`
    // implements no `Drop` (its ivars drop themselves).
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DevotPrintJob"]
    #[ivars = PrintJobState]
    pub struct PrintJob;

    // SAFETY: NSObjectProtocol has no requirements beyond NSObject's.
    unsafe impl NSObjectProtocol for PrintJob {}

    // SAFETY: each method's selector and signature match the protocol's.
    unsafe impl WKNavigationDelegate for PrintJob {
        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish_navigation(&self, web_view: &WKWebView, _navigation: Option<&WKNavigation>) {
            self.print(web_view);
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn did_fail_navigation(
            &self,
            _web_view: &WKWebView,
            _navigation: Option<&WKNavigation>,
            _error: &NSError,
        ) {
            self.load_failed("E_PRINT_LOAD_FAILED");
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn did_fail_provisional_navigation(
            &self,
            _web_view: &WKWebView,
            _navigation: Option<&WKNavigation>,
            _error: &NSError,
        ) {
            self.load_failed("E_PRINT_LOAD_FAILED");
        }

        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn web_content_process_did_terminate(&self, _web_view: &WKWebView) {
            self.load_failed("E_PRINT_LOAD_FAILED");
        }
    }

    impl PrintJob {
        /// The print operation's `didRunSelector`. AppKit calls it on the
        /// thread the operation printed on, which is not the main thread
        /// when the operation ran on a thread of its own (WebKit's print
        /// operations may, and a PDF's does), so it touches nothing of the
        /// job's and hands `success` to the main thread, where the job ends.
        #[unsafe(method(printOperationDidRun:success:contextInfo:))]
        fn print_operation_did_run(
            &self,
            _operation: &NSPrintOperation,
            success: Bool,
            _context: *mut std::ffi::c_void,
        ) {
            let success = NSNumber::numberWithBool(success.as_bool());
            // SAFETY: `printOperationEnded:` takes one object (an NSNumber)
            // and returns nothing; `performSelectorOnMainThread:withObject:
            // waitUntilDone:` retains the job and the number until it has
            // run, and is safe to call from any thread.
            unsafe {
                let _: () = msg_send![
                    self,
                    performSelectorOnMainThread: sel!(printOperationEnded:),
                    withObject: &*success,
                    waitUntilDone: false
                ];
            }
        }

        /// The print operation is over (on the main thread): the job ends
        /// with what `success` means for its target.
        #[unsafe(method(printOperationEnded:))]
        fn print_operation_ended(&self, success: &NSNumber) {
            self.finish(self.ivars().target.outcome(success.boolValue()));
        }

        /// The page did not load in time: the job ends (a print already
        /// under way is left alone).
        #[unsafe(method(loadTimedOut))]
        fn load_timed_out(&self) {
            self.load_failed("E_PRINT_TIMEOUT");
        }

        /// Lets the web view go, once the call that finished the job is over.
        #[unsafe(method(releaseWebView))]
        fn release_web_view(&self) {
            self.ivars().web_view.take();
        }
    }
);

thread_local! {
    /// The job running (one at a time); the web view's delegate is weak.
    static PRINT_JOBS: RefCell<Vec<Retained<PrintJob>>> = const { RefCell::new(Vec::new()) };
}

impl PrintJob {
    /// The page has loaded: print it.
    fn print(&self, web_view: &WKWebView) {
        if !self.ivars().loading.replace(false) {
            return;
        }
        let Some(window) = self.ivars().window.load() else {
            self.finish(Err("E_PRINT_NO_WINDOW"));
            return;
        };
        let info = NSPrintInfo::sharedPrintInfo().copy();
        info.setTopMargin(PRINT_MARGIN);
        info.setBottomMargin(PRINT_MARGIN);
        info.setLeftMargin(PRINT_MARGIN);
        info.setRightMargin(PRINT_MARGIN);
        info.setHorizontallyCentered(false);
        info.setVerticallyCentered(false);
        let to_pdf = if let PrintTarget::Pdf(path) = &self.ivars().target {
            let Some(path) = path.to_str() else {
                self.finish(Err("E_PRINT_PATH_INVALID"));
                return;
            };
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            // SAFETY: the dictionary is the print info's own, mutable by
            // design; both keys take the values AppKit documents for them
            // (a disposition string and a file URL).
            unsafe {
                let settings = info.dictionary();
                settings.insert(NSPrintJobDisposition, NSPrintSaveJob.as_ref());
                settings.insert(NSPrintJobSavingURL, url.as_ref());
            }
            true
        } else {
            false
        };
        // SAFETY: the web view is live (it called us) and the print info
        // is a fresh copy.
        let operation = unsafe { web_view.printOperationWithPrintInfo(&info) };
        operation.setShowsPrintPanel(!to_pdf);
        operation.setShowsProgressPanel(!to_pdf);
        operation.setJobTitle(Some(&NSString::from_str(&self.ivars().title)));
        // WebKit's print view starts with an empty frame, which prints blank
        // pages; give it the web view's.
        if let Some(view) = operation.view() {
            view.setFrame(web_view.frame());
        }
        // SAFETY: `self` is a live object that implements the selector with
        // the signature AppKit calls (operation, BOOL, void *); it stays
        // alive in PRINT_JOBS until the selector has run (and handed the
        // result to the main thread, which retains it until the job ends).
        unsafe {
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                &window,
                Some(self.as_ref()),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                std::ptr::null_mut(),
            );
        }
    }

    /// The page could not be laid out: the job ends with `code`, unless it
    /// is printing already. Then AppKit holds the job as the print
    /// operation's delegate (without retaining it) until `didRunSelector`,
    /// which ends it; ending it here would free it under AppKit.
    fn load_failed(&self, code: &'static str) {
        if self.ivars().loading.get() {
            self.finish(Err(code));
        }
    }

    /// Reports the result once and lets the job go: it leaves PRINT_JOBS,
    /// so the next job can start. Runs on the main thread, as every path
    /// that ends a job does (a page that cannot print, a load failure, the
    /// load timeout, the print operation's result).
    fn finish(&self, result: Result<bool, &'static str>) {
        let Some(done) = self.ivars().done.take() else {
            return;
        };
        // Nothing starts printing any more.
        self.ivars().loading.set(false);
        // The web view is released on the next turn of the run loop, not
        // inside one of its own callbacks; the delayed call keeps the job
        // alive until then.
        // SAFETY: `releaseWebView` takes no argument and returns nothing;
        // `performSelector:withObject:afterDelay:` retains `self` until it
        // runs, so cancelling the timeout's request (which drops its
        // retain) never frees the job here.
        unsafe {
            let _: () = msg_send![
                self,
                performSelector: sel!(releaseWebView),
                withObject: std::ptr::null::<AnyObject>(),
                afterDelay: 0.0f64
            ];
            // The load timeout has nothing left to do.
            let _: () = msg_send![
                objc2::class!(NSObject),
                cancelPreviousPerformRequestsWithTarget: self,
                selector: sel!(loadTimedOut),
                object: std::ptr::null::<AnyObject>()
            ];
        }
        PRINT_JOBS.with(|jobs| {
            jobs.borrow_mut()
                .retain(|job| !std::ptr::eq::<PrintJob>(&**job, self))
        });
        done(result);
    }
}

/// Lays `html` out in an offscreen web view (scripts off, nothing loaded
/// from elsewhere: see `with_print_policy`) and prints it through the
/// system print pipeline: to the print panel as a sheet on `window`, or to
/// a PDF file without a panel. `done` runs once on the main thread when the
/// job is over. One job runs at a time.
pub fn print_html(
    mtm: MainThreadMarker,
    window: &NSWindow,
    html: &str,
    title: &str,
    target: PrintTarget,
    done: PrintDone,
) {
    if PRINT_JOBS.with(|jobs| !jobs.borrow().is_empty()) {
        done(Err("E_PRINT_BUSY"));
        return;
    }
    // SAFETY: a fresh configuration; plain property access on it.
    let config = unsafe {
        let config = WKWebViewConfiguration::new(mtm);
        config
            .defaultWebpagePreferences()
            .setAllowsContentJavaScript(false);
        config
    };
    let frame = NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(PRINT_VIEW_WIDTH, PRINT_VIEW_HEIGHT),
    );
    // SAFETY: a fresh allocation initialised with a valid configuration.
    let web_view =
        unsafe { WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &config) };
    let job = PrintJob::alloc(mtm).set_ivars(PrintJobState {
        target,
        loading: Cell::new(true),
        title: title.to_owned(),
        window: Weak::new(window),
        done: RefCell::new(Some(done)),
        web_view: RefCell::new(Some(web_view.clone())),
    });
    // SAFETY: NSObject's `init` on a freshly allocated subclass instance.
    let job: Retained<PrintJob> = unsafe { msg_send![super(job), init] };
    PRINT_JOBS.with(|jobs| jobs.borrow_mut().push(job.clone()));
    let page = NSString::from_str(&with_print_policy(html));
    // SAFETY: the delegate is kept alive in PRINT_JOBS for the job's
    // length; the HTML string is copied by WebKit.
    unsafe {
        web_view.setNavigationDelegate(Some(ProtocolObject::from_ref(&*job)));
        web_view.loadHTMLString_baseURL(&page, None);
    }
    // SAFETY: `loadTimedOut` takes no argument and returns nothing;
    // `performSelector:withObject:afterDelay:` retains the job until it runs.
    unsafe {
        let _: () = msg_send![
            &*job,
            performSelector: sel!(loadTimedOut),
            withObject: std::ptr::null::<AnyObject>(),
            afterDelay: PRINT_LOAD_TIMEOUT
        ];
    }
}

/// `print_html` with the main window as the parent (its sheet shows the
/// print panel). Must run on the main thread.
pub fn print_in_main_window(
    app: &tauri::AppHandle,
    html: &str,
    title: &str,
    target: PrintTarget,
    done: PrintDone,
) {
    let Some(mtm) = MainThreadMarker::new() else {
        done(Err("E_NATIVE_NOT_MAIN_THREAD"));
        return;
    };
    let window = app
        .get_webview_window(crate::MAIN_WINDOW)
        .and_then(|window| window.ns_window().ok())
        .filter(|window| !window.is_null());
    let Some(window) = window else {
        done(Err("E_PRINT_NO_WINDOW"));
        return;
    };
    // SAFETY: `ns_window()` returns the main window's live NSWindow
    // (checked non-null above), borrowed only for this call.
    let window = unsafe { &*window.cast::<NSWindow>() };
    print_html(mtm, window, html, title, target, done);
}

/// Prints `html` to a PDF file at `path` through `print_html`, with an
/// offscreen window as the parent, running the run loop until it is done.
/// For the main-thread tests (`tests/main_thread.rs`).
#[doc(hidden)]
pub fn self_test_print_to_pdf(html: &str, path: &std::path::Path) -> Result<(), &'static str> {
    use objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSRunLoop};
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
    let result = std::rc::Rc::new(RefCell::new(None));
    let slot = std::rc::Rc::clone(&result);
    print_html(
        mtm,
        &window,
        html,
        "Devot",
        PrintTarget::Pdf(path.to_owned()),
        Box::new(move |r| *slot.borrow_mut() = Some(r)),
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let run_loop = NSRunLoop::currentRunLoop();
    while result.borrow().is_none() && std::time::Instant::now() < deadline {
        // SAFETY: the default mode constant is a valid run loop mode.
        unsafe {
            run_loop.runMode_beforeDate(
                NSDefaultRunLoopMode,
                &NSDate::dateWithTimeIntervalSinceNow(0.05),
            );
        }
    }
    // Let the delayed release run.
    // SAFETY: as above.
    unsafe {
        run_loop.runMode_beforeDate(
            NSDefaultRunLoopMode,
            &NSDate::dateWithTimeIntervalSinceNow(0.1),
        );
    }
    window.close();
    match result.borrow_mut().take() {
        Some(Ok(true)) => Ok(()),
        Some(Ok(false)) => Err("E_PRINT_CANCELLED"),
        Some(Err(code)) => Err(code),
        None => Err("E_PRINT_TIMEOUT"),
    }
}

/// How many print jobs hold the print slot (none once every job is over).
/// For the main-thread tests (`tests/main_thread.rs`).
#[doc(hidden)]
pub fn self_test_print_jobs() -> usize {
    PRINT_JOBS.with(|jobs| jobs.borrow().len())
}

/// The Mach exceptions the crash handler catches (`crash_handler` takes the
/// same set): bad memory access, bad instruction, arithmetic, breakpoint,
/// crash, resource and guard.
const CRASH_EXCEPTIONS: mach2::exception_types::exception_mask_t = {
    use mach2::exception_types::*;
    EXC_MASK_BAD_ACCESS
        | EXC_MASK_BAD_INSTRUCTION
        | EXC_MASK_ARITHMETIC
        | EXC_MASK_BREAKPOINT
        | EXC_MASK_CRASH
        | EXC_MASK_RESOURCE
        | EXC_MASK_GUARD
};
/// `EXC_TYPES_COUNT` in `<mach/exception_types.h>`.
const EXCEPTION_TYPES: usize = 14;

/// What handled crashes before the crash handler was attached: the
/// `SIGABRT` action and the task's exception ports.
struct Before {
    abort: libc::sigaction,
    count: usize,
    masks: [mach2::exception_types::exception_mask_t; EXCEPTION_TYPES],
    ports: [mach2::port::mach_port_t; EXCEPTION_TYPES],
    behaviors: [mach2::exception_types::exception_behavior_t; EXCEPTION_TYPES],
    flavors: [mach2::thread_status::thread_state_flavor_t; EXCEPTION_TYPES],
}

static BEFORE: std::sync::OnceLock<Before> = std::sync::OnceLock::new();
/// The `SIGABRT` action `crash_handler` installed, which `on_abort` runs.
static HANDLER_ABORT: std::sync::OnceLock<libc::sigaction> = std::sync::OnceLock::new();

/// The process-wide native crash handler, attached for the app's life.
pub struct CrashHandler {
    _handler: crash_handler::CrashHandler,
}

/// Attaches the process-wide native crash handler (Mach exception ports,
/// plus a `SIGABRT` hook for aborts and for the signal sent by another
/// process). `on_crash` runs on the handler's own thread while every other
/// thread is suspended; it returns whether the crash was handed to the crash
/// reporter. Once a crash has been reported the process ends as it would
/// have without the handler: a Mach exception goes on to the handlers that
/// were there before, and a `SIGABRT` is raised again under the action that
/// was there before (the default ends the process). One handler per
/// process; it is never attached again (`detach_crash_handler`).
pub fn attach_crash_handler(
    on_crash: impl Fn(&crash_handler::CrashContext) -> bool + Send + Sync + 'static,
) -> Result<CrashHandler, crash_handler::Error> {
    // SAFETY: `make_crash_event` is unsafe because its closure runs while the
    // process is crashing. On macOS the closure runs on the handler's own
    // thread, not in a signal handler, with the other threads suspended; the
    // caller's `on_crash` only sends one Mach message and waits for the reply,
    // so it takes no lock and allocates nothing that a suspended thread could
    // be holding.
    let event = unsafe {
        crash_handler::make_crash_event(move |context| {
            crash_handler::CrashEventResult::Handled(on_crash(context))
        })
    };
    if BEFORE.get().is_none() {
        let before = save_crash_handling()
            .ok_or_else(|| crash_handler::Error::Io(std::io::Error::last_os_error()))?;
        let _ = BEFORE.set(before);
    }
    // SAFETY: a signal set on this thread's stack, filled by sigemptyset and
    // sigaddset before pthread_sigmask reads it; `previous` is written by
    // pthread_sigmask before it is read back below.
    let previous = unsafe {
        let mut abort: libc::sigset_t = std::mem::zeroed();
        let mut previous: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut abort);
        libc::sigaddset(&mut abort, libc::SIGABRT);
        libc::pthread_sigmask(libc::SIG_BLOCK, &abort, &mut previous);
        previous
    };
    // The handler's thread starts here and inherits this thread's signal
    // mask, so a SIGABRT sent to the process never lands on the one thread
    // that must answer it (its handler would wait for that thread).
    let handler = crash_handler::CrashHandler::attach(event);
    // SAFETY: restores this thread's mask from the value saved above.
    unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut()) };
    let handler = handler?;
    // SAFETY: reads the SIGABRT action crash_handler installed into a
    // zeroed sigaction, then installs `on_abort` (a plain extern "C"
    // function with the SA_SIGINFO signature) over it; `on_abort` calls the
    // saved action itself.
    unsafe {
        let mut installed: libc::sigaction = std::mem::zeroed();
        libc::sigaction(libc::SIGABRT, std::ptr::null(), &mut installed);
        let _ = HANDLER_ABORT.set(installed);
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = on_abort as *const () as libc::sighandler_t;
        action.sa_flags = libc::SA_SIGINFO;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaddset(&mut action.sa_mask, libc::SIGABRT);
        libc::sigaction(libc::SIGABRT, &action, std::ptr::null_mut());
    }
    Ok(CrashHandler { _handler: handler })
}

/// The `SIGABRT` action and exception ports before the handler is attached.
fn save_crash_handling() -> Option<Before> {
    // SAFETY: plain C structs and arrays on this stack, filled by sigaction
    // and task_get_exception_ports, which write at most `count` entries.
    unsafe {
        let mut before: Before = std::mem::zeroed();
        if libc::sigaction(libc::SIGABRT, std::ptr::null(), &mut before.abort) != 0 {
            return None;
        }
        let mut count = EXCEPTION_TYPES as u32;
        let saved = mach2::task::task_get_exception_ports(
            mach2::traps::mach_task_self(),
            CRASH_EXCEPTIONS,
            before.masks.as_mut_ptr(),
            &mut count,
            before.ports.as_mut_ptr(),
            before.behaviors.as_mut_ptr(),
            before.flavors.as_mut_ptr(),
        );
        if saved != mach2::kern_return::KERN_SUCCESS {
            return None;
        }
        before.count = (count as usize).min(EXCEPTION_TYPES);
        Some(before)
    }
}

/// Detaches the crash handler, for good: the `SIGABRT` action and the
/// exception ports go back to what they were before it was attached, so a
/// crash takes the system's default course. Safe to call more than once, and
/// from a signal handler (it only makes system calls). The handler's own
/// thread stays, idle, as no exception reaches it any more. Returns whether
/// there was anything to restore.
pub fn detach_crash_handler() -> bool {
    let Some(before) = BEFORE.get() else {
        return false;
    };
    // SAFETY: restores values saved by `save_crash_handling`; sigaction and
    // task_set_exception_ports are system calls that are safe in a signal
    // handler.
    unsafe {
        libc::sigaction(libc::SIGABRT, &before.abort, std::ptr::null_mut());
        let task = mach2::traps::mach_task_self();
        for i in 0..before.count {
            mach2::task::task_set_exception_ports(
                task,
                before.masks[i],
                before.ports[i],
                before.behaviors[i],
                before.flavors[i],
            );
        }
    }
    true
}

/// Whether a crash would reach the crash handler now: `SIGABRT` runs its
/// hook, or a bad memory access goes to another port than before it was
/// attached.
pub fn crash_handler_attached() -> bool {
    let Some(before) = BEFORE.get() else {
        return false;
    };
    // SAFETY: plain C structs and arrays on this stack, filled by sigaction
    // and task_get_exception_ports, which write at most `count` entries.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        libc::sigaction(libc::SIGABRT, std::ptr::null(), &mut action);
        if action.sa_sigaction == on_abort as *const () as libc::sighandler_t {
            return true;
        }
        let mask = mach2::exception_types::EXC_MASK_BAD_ACCESS;
        let mut masks = [0; EXCEPTION_TYPES];
        let mut ports = [0; EXCEPTION_TYPES];
        let mut behaviors = [0; EXCEPTION_TYPES];
        let mut flavors = [0; EXCEPTION_TYPES];
        let mut count = EXCEPTION_TYPES as u32;
        mach2::task::task_get_exception_ports(
            mach2::traps::mach_task_self(),
            mask,
            masks.as_mut_ptr(),
            &mut count,
            ports.as_mut_ptr(),
            behaviors.as_mut_ptr(),
            flavors.as_mut_ptr(),
        );
        let port_for = |masks: &[u32], ports: &[u32]| {
            masks
                .iter()
                .zip(ports)
                .find(|(m, _)| *m & mask != 0)
                .map_or(0, |(_, p)| *p)
        };
        let now = port_for(&masks[..count as usize], &ports[..count as usize]);
        now != port_for(&before.masks[..before.count], &before.ports[..before.count])
    }
}

/// The `SIGABRT` handler: an abort or a `kill -ABRT` from another process.
/// Hands the crash to `crash_handler` (which waits for the reporter), then
/// detaches and raises the signal again. The signal stays blocked until this
/// returns, so it is then taken by the action from before: by default, the
/// process ends with `SIGABRT`.
extern "C" fn on_abort(
    signal: libc::c_int,
    info: *mut libc::siginfo_t,
    context: *mut libc::c_void,
) {
    if let Some(action) = HANDLER_ABORT.get() {
        // SAFETY: crash_handler installed this action with SA_SIGINFO, so its
        // handler takes these three arguments, passed on as received.
        unsafe { run_action(action, signal, info, context) };
    }
    // SAFETY: without a saved action, the default one ends the process;
    // signal and raise are system calls, and raise only signals this thread.
    unsafe {
        if !detach_crash_handler() {
            libc::signal(signal, libc::SIG_DFL);
        }
        libc::raise(signal);
    }
}

/// Runs a saved signal action's handler, if it has one.
///
/// # Safety
/// `info` and `context` must be what the kernel passed to the running
/// signal handler.
unsafe fn run_action(
    action: &libc::sigaction,
    signal: libc::c_int,
    info: *mut libc::siginfo_t,
    context: *mut libc::c_void,
) {
    let handler = action.sa_sigaction;
    if handler == libc::SIG_DFL || handler == libc::SIG_IGN {
        return;
    }
    if action.sa_flags & libc::SA_SIGINFO != 0 {
        // SAFETY: an SA_SIGINFO action's handler has this signature.
        let run: extern "C" fn(libc::c_int, *mut libc::siginfo_t, *mut libc::c_void) =
            unsafe { std::mem::transmute(handler) };
        run(signal, info, context);
    } else {
        // SAFETY: any other action's handler takes the signal number alone.
        let run: extern "C" fn(libc::c_int) = unsafe { std::mem::transmute(handler) };
        run(signal);
    }
}

/// The path of a running process's executable, as the system knows it.
pub fn executable_of(pid: u32) -> Option<std::path::PathBuf> {
    let pid = libc::c_int::try_from(pid).ok()?;
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: proc_pidpath writes at most `buffer.len()` bytes into the
    // buffer and returns how many it wrote (0 or less on failure).
    let written =
        unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    let written = usize::try_from(written).ok().filter(|&n| n > 0)?;
    buffer.truncate(written);
    use std::os::unix::ffi::OsStringExt;
    Some(std::ffi::OsString::from_vec(buffer).into())
}

/// Loads a Mach-O bundle (a plug-in, as AppKit and WebKit load), so that
/// the native crash tests crash a process that has one loaded.
#[cfg(debug_assertions)]
#[doc(hidden)]
pub fn load_bundle(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: a NUL-terminated path; the handle is kept open for the
    // process's life.
    !unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_NOW) }.is_null()
}

/// Stops the process with a bad memory access (`EXC_BAD_ACCESS`), as a crash
/// inside AppKit or WebKit would. Only the native crash tests call it.
#[cfg(debug_assertions)]
#[doc(hidden)]
pub fn crash_with_bad_access() -> ! {
    let unmapped = std::ptr::without_provenance_mut::<u64>(0x10);
    // SAFETY: deliberately unsound, to crash: the first 4 GiB of a macOS
    // process are never mapped, so this write faults and the process stops.
    unsafe { unmapped.write_volatile(0) };
    unreachable!("E_BAD_ACCESS_DID_NOT_CRASH")
}

/// Time since boot, sleep included: `CLOCK_MONOTONIC` keeps counting while
/// the Mac sleeps (`Instant` is `CLOCK_UPTIME_RAW`, which stops), and
/// setting the time does not move it. `None` if the call fails.
pub fn time_since_boot() -> Option<std::time::Duration> {
    let mut now = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: `now` is a valid, writable timespec that outlives the call, and
    // CLOCK_MONOTONIC is a clock macOS has (10.12 and later).
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut now) } != 0 {
        return None;
    }
    Some(std::time::Duration::new(
        u64::try_from(now.tv_sec).ok()?,
        u32::try_from(now.tv_nsec).ok()?,
    ))
}

/// Stops the process by calling a function at `address`, where no code is:
/// what calling a pointer made of data (note text) does. Only the native
/// crash tests call it.
#[cfg(debug_assertions)]
#[doc(hidden)]
pub fn crash_with_call_to(address: usize) -> ! {
    // SAFETY: deliberately unsound, to crash: the caller passes an address
    // nothing is mapped at, so the call faults and the process stops.
    let call = unsafe { std::mem::transmute::<usize, extern "C" fn()>(address) };
    std::hint::black_box(call)();
    unreachable!("E_CALL_DID_NOT_CRASH")
}

// ---- Launch failure alert ----------------------------------------------------

use objc2_app_kit::{NSAlert, NSAlertStyle};

/// Shows a critical alert and waits until it is dismissed, bringing the app
/// forward first (at launch it has no window yet). Public AppKit only. False,
/// showing nothing, off the main thread.
pub fn show_critical_alert(title: &str, message: &str) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    NSApplication::sharedApplication(mtm).activate();
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Critical);
    alert.setMessageText(&NSString::from_str(title));
    alert.setInformativeText(&NSString::from_str(message));
    alert.runModal();
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tests that touch WebKit run on the main thread in
    // tests/webkit_main_thread.rs; libtest's worker threads crash WebKit.

    #[test]
    fn time_since_boot_runs_forward() {
        let first = time_since_boot().expect("clock");
        let then = time_since_boot().expect("clock");
        assert!(first > std::time::Duration::ZERO);
        assert!(then >= first);
    }

    #[test]
    fn a_guarded_call_that_panics_gives_the_fallback() {
        let fell_back = guarded("W_NATIVE_TEST_PANIC", || -> Option<()> {
            panic!("E_NATIVE_TEST_PANIC")
        });
        assert_eq!(fell_back, None);
        assert_eq!(guarded("W_NATIVE_TEST", || Some(7)), Some(7));
    }

    #[test]
    fn refuses_a_null_preferences_object() {
        // SAFETY: null is explicitly allowed by the contract.
        assert!(!unsafe { set_sixty_fps_feature(std::ptr::null_mut(), false) });
    }

    #[test]
    fn self_test_refuses_worker_threads() {
        assert_eq!(
            self_test_sixty_fps_toggle(),
            Err("E_NATIVE_NOT_MAIN_THREAD")
        );
        assert_eq!(
            self_test_format_menu_keys(),
            Err("E_NATIVE_NOT_MAIN_THREAD")
        );
    }

    #[test]
    fn a_pdf_not_written_failed_while_a_print_not_printed_was_cancelled() {
        // AppKit's `success` flag: a print through the panel that did not
        // print was cancelled there; a PDF has no panel, so it failed.
        let pdf = PrintTarget::Pdf("note.pdf".into());
        assert_eq!(pdf.outcome(true), Ok(true));
        assert_eq!(pdf.outcome(false), Err("E_EXPORT_PDF_FAILED"));
        assert_eq!(PrintTarget::Printer.outcome(true), Ok(true));
        assert_eq!(PrintTarget::Printer.outcome(false), Ok(false));
    }

    #[test]
    fn puts_the_print_policy_before_anything_of_the_page() {
        let meta =
            format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{PRINT_POLICY}\">");
        let start = format!("<!doctype html>{meta}");
        // The page's own doctype, in any case, gives way to the one before
        // the policy; everything else stays as it was, in order.
        let page = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">";
        assert_eq!(
            with_print_policy(page),
            format!("{start}\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">")
        );
        // Without a doctype of its own (or with another one), nothing of
        // the page is dropped.
        assert_eq!(
            with_print_policy("<img src=\"http://example.com/a.png\">"),
            format!("{start}<img src=\"http://example.com/a.png\">")
        );
        let legacy = "<!DOCTYPE html PUBLIC \"-//W3C//DTD HTML 4.01//EN\"><p>x</p>";
        assert_eq!(with_print_policy(legacy), format!("{start}{legacy}"));
        assert_eq!(with_print_policy(""), start);
        // Only images from the page itself.
        assert!(PRINT_POLICY.contains("default-src 'none'"));
        assert!(PRINT_POLICY.contains("img-src data:;"));
        assert!(!PRINT_POLICY.contains("http"));
    }
}
