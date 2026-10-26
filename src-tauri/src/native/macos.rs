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
    NSBitmapImageFileType, NSBitmapImageRep, NSFont, NSFontManager, NSFontTraitMask,
    NSFontWeightBlack, NSFontWeightBold, NSFontWeightHeavy, NSFontWeightLight, NSFontWeightMedium,
    NSFontWeightRegular, NSFontWeightSemibold, NSFontWeightThin, NSFontWeightUltraLight, NSImage,
    NSImageSymbolConfiguration, NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeString,
    NSPasteboardTypeTIFF,
};
use objc2_foundation::{NSData, NSDictionary, NSString};
use tauri::Manager;

use super::guarded;

/// Paces page rendering updates near 60 fps by default, even on 120 Hz displays.
const SIXTY_FPS_FEATURE: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";

/// Per web view: every main window needs it.
pub fn unlock_high_refresh_rate(window: &tauri::WebviewWindow) {
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

/// WebKit's private objects can change in any update, so each message is sent only to an object
/// that answers it (`respondsToSelector:`) and the key is read only when it is a string.
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

/// Run on the main thread (`tests/main_thread.rs`).
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

/// Returns false when WebKit does not offer it.
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

/// One call at a time (`native::render_one_at_a_time`); AppKit's temporaries go in an autorelease
/// pool of the call's own, as a blocking thread has none to empty.
pub fn symbol_png(name: &str, point_size: f64, weight: &str) -> Option<Vec<u8>> {
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
                    point_size * super::SYMBOL_PIXELS_PER_POINT,
                    symbol_weight(weight),
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

fn symbol_weight(name: &str) -> f64 {
    // SAFETY: these are immutable AppKit constants (macOS 10.11+), valid for
    // the life of the process.
    unsafe {
        match name {
            "ultralight" => NSFontWeightUltraLight,
            "thin" => NSFontWeightThin,
            "light" => NSFontWeightLight,
            "medium" => NSFontWeightMedium,
            "semibold" => NSFontWeightSemibold,
            "bold" => NSFontWeightBold,
            "heavy" => NSFontWeightHeavy,
            "black" => NSFontWeightBlack,
            _ => NSFontWeightRegular,
        }
    }
}

/// Must run on the main thread; none when it is not.
pub fn font_families() -> Vec<String> {
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        return Vec::new();
    };
    catch_unwind(AssertUnwindSafe(|| {
        objc2::rc::autoreleasepool(|_| {
            let manager = objc2_app_kit::NSFontManager::sharedFontManager(mtm);
            manager
                .availableFontFamilies()
                .iter()
                .map(|name| name.to_string())
                .collect()
        })
    }))
    .unwrap_or_default()
}

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

/// Marker types clipboard managers honour (nspasteboard.org): skip the item, keep no history.
const CONCEALED_TYPE: &str = "org.nspasteboard.ConcealedType";
const TRANSIENT_TYPE: &str = "org.nspasteboard.TransientType";

/// Puts a secret on the general pasteboard for this Mac only (no Universal Clipboard), marked
/// concealed and transient. Returns the pasteboard's change count, for
/// [`clear_clipboard_if_unchanged`].
pub fn write_secret_clipboard_text(text: &str) -> Option<isize> {
    catch_unwind(|| write_secret_text_to(&NSPasteboard::generalPasteboard(), text)).unwrap_or(None)
}

fn write_secret_text_to(pasteboard: &NSPasteboard, text: &str) -> Option<isize> {
    pasteboard.prepareForNewContentsWithOptions(
        objc2_app_kit::NSPasteboardContentsOptions::CurrentHostOnly,
    );
    // SAFETY: `NSPasteboardTypeString` is an immutable AppKit constant
    // (macOS 10.6+), valid for the life of the process.
    let kind = unsafe { NSPasteboardTypeString };
    let marked = [CONCEALED_TYPE, TRANSIENT_TYPE].iter().all(|marker| {
        pasteboard.setData_forType(Some(&NSData::new()), &NSString::from_str(marker))
    });
    (marked && pasteboard.setString_forType(&NSString::from_str(text), kind))
        .then(|| pasteboard.changeCount())
}

/// Clears the general pasteboard when nothing was put on it since `count`.
pub fn clear_clipboard_if_unchanged(count: isize) {
    let _ = catch_unwind(|| clear_if_unchanged(&NSPasteboard::generalPasteboard(), count));
}

fn clear_if_unchanged(pasteboard: &NSPasteboard, count: isize) -> bool {
    pasteboard.changeCount() == count && {
        pasteboard.clearContents();
        true
    }
}

pub struct PasteboardImage {
    pub png: Option<Vec<u8>>,
    pub tiff: Vec<u8>,
}

/// A PNG keeps its own bytes; other formats are converted. Safe off the main thread (NSImage and
/// NSBitmapImageRep decode on any thread), so the work never stalls the UI. `E_IMAGE_TOO_LARGE`
/// when its header gives more than `max_pixels` pixels: nothing is decoded then.
/// AppKit's temporaries (several decoded copies) go in an autorelease pool of the call's own: a
/// thread with no pool keeps them until it exits, and a blocking-pool thread lives on for 10 s and
/// more, so a few copies of a large photo held hundreds of MB.
pub fn pasteboard_image(bytes: &[u8], max_pixels: u64) -> Result<PasteboardImage, &'static str> {
    catch_unwind(AssertUnwindSafe(|| {
        objc2::rc::autoreleasepool(|_| {
            let data = NSData::with_bytes(bytes);
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

pub fn write_clipboard_image(image: &PasteboardImage) -> bool {
    write_image(&NSPasteboard::generalPasteboard(), image)
}

/// Uses a private pasteboard (the user's clipboard is left alone). Run on the main thread.
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

/// As Activity Monitor shows it; the main-thread tests read it to check that native work frees what
/// it used.
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

/// `Ok(None)` when the pasteboard holds no text; an error code when AppKit failed.
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

/// WebKit kills the process when this runs off the main thread, so it refuses to.
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

/// The observer lives for the rest of the process.
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

use objc2::MainThreadMarker;
use objc2::rc::{Retained, Weak};
use objc2_app_kit::{NSApplication, NSEvent, NSEventMask, NSEventModifierFlags, NSMenu, NSWindow};

/// AppKit asks the key window's views for a key equivalent before the menu bar, and the web view
/// took Command-I in the editor without passing it on; a local event monitor runs before both. Only
/// the Format menu is asked, so every other key goes its usual way, and that menu has keys only
/// while the editor has the keyboard (`format_menu`). While an input method composes (marked text)
/// no key is offered. The windows it serves are the main windows `super::track_main_window` lists
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
        Some(window) if super::is_main_window(Retained::as_ptr(window).cast()) => WindowIs::Main,
        Some(_) => WindowIs::Other,
    };
    let app = NSApplication::sharedApplication(mtm);
    let key_ns_window = app.keyWindow();
    let event_window = which(&event.window(mtm));
    let key_window = which(&key_ns_window);
    let command = flags.contains(NSEventModifierFlags::Command);
    let control = flags.contains(NSEventModifierFlags::Control);
    let key = super::KeyDown {
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
    use objc2::MainThreadOnly;
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

thread_local! {
    static SYNTHESIZER: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextServices {
    pub look_up: bool,
    pub start_speaking: bool,
    pub stop_speaking: bool,
}

/// # Safety
/// `web_view` must be null or point to a live `WKWebView`.
unsafe fn text_services(web_view: *mut AnyObject) -> TextServices {
    if web_view.is_null() {
        return TextServices {
            look_up: false,
            start_speaking: false,
            stop_speaking: false,
        };
    }
    // SAFETY: `web_view` is live (caller contract); every NSObject responds
    // to respondsToSelector:.
    unsafe {
        TextServices {
            look_up: responds(web_view, sel!(showDefinitionForAttributedString:atPoint:)),
            start_speaking: responds(web_view, sel!(startSpeaking:)),
            stop_speaking: responds(web_view, sel!(stopSpeaking:)),
        }
    }
}

/// `Err` carries a code: the point is outside the view, or the web view cannot look up.
pub fn look_up(
    webview: &tauri::webview::PlatformWebview,
    text: &str,
    x: f64,
    y: f64,
    style: &super::LookUpStyle,
) -> Result<(), &'static str> {
    let web_view: *mut AnyObject = webview.inner().cast();
    guarded("W_NATIVE_LOOK_UP_FAILED", || {
        // SAFETY: `inner()` is the live WKWebView owned by the window; the
        // call runs on the main thread (`with_webview`).
        Some(unsafe { look_up_in(web_view, text, x, y, style) })
    })
    .unwrap_or(Err("E_LOOK_UP_FAILED"))
}

/// # Safety
/// `web_view` must be null or point to a live `WKWebView`; main thread.
unsafe fn look_up_in(
    web_view: *mut AnyObject,
    text: &str,
    x: f64,
    y: f64,
    style: &super::LookUpStyle,
) -> Result<(), &'static str> {
    // SAFETY: `web_view` is null or live (caller contract).
    if !unsafe { text_services(web_view) }.look_up {
        return Err("E_LOOK_UP_UNAVAILABLE");
    }
    // SAFETY: the view responds to `bounds` (every NSView does).
    let bounds: NSRect = unsafe { msg_send![web_view, bounds] };
    if x > bounds.size.width || y > bounds.size.height {
        return Err("E_LOOK_UP_OUTSIDE_VIEW");
    }
    let class = AnyClass::get(c"NSAttributedString").ok_or("E_LOOK_UP_UNAVAILABLE")?;
    let string = NSString::from_str(text);
    // The word is drawn in the text's own font, so the highlight covers it.
    let font = look_up_font(style);
    // SAFETY: `NSFontAttributeName` is an immutable AppKit constant, valid
    // for the life of the process.
    let key = unsafe { objc2_app_kit::NSFontAttributeName };
    let attributes = NSDictionary::<NSString, AnyObject>::from_slices(&[key], &[font.as_ref()]);
    // SAFETY: `alloc` and `initWithString:attributes:` are
    // NSAttributedString's own designated pair; `string` is an NSString,
    // `attributes` maps NSFontAttributeName to an NSFont; the result is owned.
    let attributed: Option<Retained<AnyObject>> = unsafe {
        let fresh: *mut AnyObject = msg_send![class, alloc];
        let made: *mut AnyObject =
            msg_send![fresh, initWithString: &*string, attributes: &*attributes];
        Retained::from_raw(made)
    };
    let attributed = attributed.ok_or("E_LOOK_UP_UNAVAILABLE")?;
    // SAFETY: the selector was checked above; the string is a live
    // NSAttributedString and the point lies inside the view.
    unsafe {
        let _: () = msg_send![
            web_view,
            showDefinitionForAttributedString: &*attributed,
            atPoint: NSPoint::new(x, y)
        ];
    }
    Ok(())
}

fn look_up_font(style: &super::LookUpStyle) -> Retained<NSFont> {
    let size = style.size.unwrap_or_else(NSFont::systemFontSize);
    let weight = symbol_weight(style.weight);
    let found = style.sources.iter().find_map(|source| match source {
        super::FontSource::System => Some(NSFont::systemFontOfSize_weight(size, weight)),
        super::FontSource::Monospaced => {
            Some(NSFont::monospacedSystemFontOfSize_weight(size, weight))
        }
        super::FontSource::Installed(family) => installed_font(family, style, size),
        super::FontSource::File(bytes) => file_font(bytes, size, weight, style.italic),
    });
    let font = found.unwrap_or_else(|| NSFont::systemFontOfSize_weight(size, weight));
    if !style.italic {
        return font;
    }
    let mtm = objc2::MainThreadMarker::new();
    match mtm {
        // An installed family was asked for italic already; for the others
        // the font manager finds the italic face, or keeps the font.
        Some(mtm) => NSFontManager::sharedFontManager(mtm)
            .convertFont_toHaveTrait(&font, NSFontTraitMask::ItalicFontMask),
        None => font,
    }
}

/// None when the family is not installed.
fn installed_font(family: &str, style: &super::LookUpStyle, size: f64) -> Option<Retained<NSFont>> {
    let manager = NSFontManager::sharedFontManager(objc2::MainThreadMarker::new()?);
    let family = NSString::from_str(family);
    let mut traits = NSFontTraitMask::empty();
    if style.italic {
        traits |= NSFontTraitMask::ItalicFontMask;
    }
    if style.manager_weight >= 9 {
        traits |= NSFontTraitMask::BoldFontMask;
    }
    manager
        .fontWithFamily_traits_weight_size(&family, traits, style.manager_weight, size)
        .or_else(|| {
            manager.fontWithFamily_traits_weight_size(&family, NSFontTraitMask::empty(), 5, size)
        })
}

#[link(name = "CoreText", kind = "framework")]
unsafe extern "C" {
    fn CTFontManagerCreateFontDescriptorsFromData(data: *const AnyObject) -> *mut AnyObject;
    fn CTFontCreateWithFontDescriptor(
        descriptor: *const AnyObject,
        size: f64,
        matrix: *const std::ffi::c_void,
    ) -> *mut AnyObject;
    fn CTFontDescriptorCopyAttribute(
        descriptor: *const AnyObject,
        attribute: *const AnyObject,
    ) -> *mut AnyObject;
    #[allow(non_upper_case_globals)]
    static kCTFontTraitsAttribute: *const AnyObject;
    #[allow(non_upper_case_globals)]
    static kCTFontWeightTrait: *const AnyObject;
    #[allow(non_upper_case_globals)]
    static kCTFontSymbolicTrait: *const AnyObject;
}

const ITALIC_TRAIT: u32 = 1 << 0;

fn face_traits(descriptor: &AnyObject) -> Option<(f64, bool)> {
    // SAFETY: `descriptor` is a live CTFontDescriptor and the attribute an
    // immutable CoreText constant; the result is a +1 CFDictionary (toll-free
    // bridged with NSDictionary) or null, owned here.
    let traits: Retained<NSDictionary<NSString, AnyObject>> = unsafe {
        let made = CTFontDescriptorCopyAttribute(descriptor, kCTFontTraitsAttribute);
        Retained::from_raw(made.cast())?
    };
    let number = |key: *const AnyObject| {
        // SAFETY: `key` is an immutable CoreText CFString constant (toll-free
        // bridged with NSString), valid for the life of the process.
        let key = unsafe { key.cast::<NSString>().as_ref() }?;
        traits.objectForKey(key)?.downcast::<NSNumber>().ok()
    };
    // SAFETY: reading immutable CoreText constants.
    let (weight_key, symbolic_key) = unsafe { (kCTFontWeightTrait, kCTFontSymbolicTrait) };
    let weight = number(weight_key)?.as_f64();
    let symbolic = number(symbolic_key).map_or(0, |bits| bits.as_u32());
    Some((weight, symbolic & ITALIC_TRAIT != 0))
}

/// Made for this call only: nothing is registered with the system.
fn file_font(bytes: &[u8], size: f64, weight: f64, italic: bool) -> Option<Retained<NSFont>> {
    let data = NSData::with_bytes(bytes);
    // SAFETY: NSData is toll-free bridged with CFData; the function returns
    // a +1 CFArray (toll-free bridged with NSArray) or null, owned here.
    let descriptors: Retained<objc2_foundation::NSArray<AnyObject>> = unsafe {
        let made = CTFontManagerCreateFontDescriptorsFromData(Retained::as_ptr(&data).cast());
        Retained::from_raw(made.cast())?
    };
    let descriptors: Vec<_> = descriptors.iter().collect();
    let faces: Vec<_> = descriptors.iter().map(|face| face_traits(face)).collect();
    let descriptor = descriptors.get(super::closest_face(&faces, weight, italic))?;
    // SAFETY: `descriptor` is a CTFontDescriptor from the array above; a null
    // matrix is the identity; the result is a +1 CTFont, which is an NSFont.
    unsafe {
        let made =
            CTFontCreateWithFontDescriptor(Retained::as_ptr(descriptor), size, std::ptr::null());
        Retained::from_raw(made.cast())
    }
}

/// The web view speaks its own selection when it can (the system's Speech actions); otherwise
/// `text` is spoken by a speech synthesizer. Stopping stops both.
pub fn speak(
    webview: &tauri::webview::PlatformWebview,
    start: bool,
    text: Option<&str>,
) -> Result<(), &'static str> {
    let web_view: *mut AnyObject = webview.inner().cast();
    guarded("W_NATIVE_SPEECH_FAILED", || {
        // SAFETY: `inner()` is the live WKWebView owned by the window; the
        // call runs on the main thread (`with_webview`).
        Some(unsafe { speak_in(web_view, start, text) })
    })
    .unwrap_or(Err("E_SPEECH_FAILED"))
}

/// # Safety
/// `web_view` must be null or point to a live `WKWebView`; main thread.
unsafe fn speak_in(
    web_view: *mut AnyObject,
    start: bool,
    text: Option<&str>,
) -> Result<(), &'static str> {
    // SAFETY: `web_view` is null or live (caller contract).
    let services = unsafe { text_services(web_view) };
    let nothing: *const AnyObject = std::ptr::null();
    if !start {
        if services.stop_speaking {
            // SAFETY: the selector was checked; a nil sender is allowed.
            unsafe {
                let _: () = msg_send![web_view, stopSpeaking: nothing];
            }
        }
        stop_synthesizer();
        return Ok(());
    }
    if services.start_speaking {
        // SAFETY: the selector was checked; a nil sender is allowed.
        unsafe {
            let _: () = msg_send![web_view, startSpeaking: nothing];
        }
        return Ok(());
    }
    let text = text.ok_or("E_SPEECH_NOTHING_TO_SAY")?;
    speak_with_synthesizer(text)
}

fn stop_synthesizer() {
    SYNTHESIZER.with(|cell| {
        if let Some(synthesizer) = cell.borrow().as_ref() {
            let object = Retained::as_ptr(synthesizer).cast_mut();
            // SAFETY: `object` is the live synthesizer kept here; checked
            // before the call.
            unsafe {
                if responds(object, sel!(stopSpeaking)) {
                    let _: () = msg_send![object, stopSpeaking];
                }
            }
        }
    });
}

fn speak_with_synthesizer(text: &str) -> Result<(), &'static str> {
    let class = AnyClass::get(c"NSSpeechSynthesizer").ok_or("E_SPEECH_UNAVAILABLE")?;
    SYNTHESIZER.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            // SAFETY: `alloc` and `init` are NSSpeechSynthesizer's own pair;
            // the result is owned.
            *slot = unsafe {
                let fresh: *mut AnyObject = msg_send![class, alloc];
                let made: *mut AnyObject = msg_send![fresh, init];
                Retained::from_raw(made)
            };
        }
        let synthesizer = slot.as_ref().ok_or("E_SPEECH_UNAVAILABLE")?;
        let object = Retained::as_ptr(synthesizer).cast_mut();
        let string = NSString::from_str(text);
        // SAFETY: `object` is the live synthesizer kept in the slot; the
        // selectors are checked before the calls; `string` is an NSString.
        unsafe {
            if !responds(object, sel!(startSpeakingString:)) {
                return Err("E_SPEECH_UNAVAILABLE");
            }
            if responds(object, sel!(stopSpeaking)) {
                let _: () = msg_send![object, stopSpeaking];
            }
            let started: Bool = msg_send![object, startSpeakingString: &*string];
            if !started.as_bool() {
                return Err("E_SPEECH_NOT_STARTED");
            }
        }
        Ok(())
    })
}

/// Checks on a real web view, without showing anything, that a missing selector gives a code, not a
/// crash. Main thread only.
#[doc(hidden)]
pub fn self_test_look_up_speech() -> Result<(), &'static str> {
    let mtm = MainThreadMarker::new().ok_or("E_NATIVE_NOT_MAIN_THREAD")?;
    let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(400.0, 300.0));
    // SAFETY: a fresh configuration, made on the main thread.
    let config = unsafe { WKWebViewConfiguration::new(mtm) };
    // SAFETY: a fresh allocation with a valid frame and configuration.
    let web_view =
        unsafe { WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), rect, &config) };
    let object = Retained::as_ptr(&web_view).cast::<AnyObject>().cast_mut();
    // SAFETY: `object` is the live web view retained above.
    let services = unsafe { text_services(object) };
    if !services.look_up {
        return Err("E_LOOK_UP_SELECTOR_MISSING");
    }
    if !services.start_speaking || !services.stop_speaking {
        return Err("E_SPEECH_SELECTORS_MISSING");
    }
    let style = super::look_up_style(None, |_| None);
    // A point outside the view is refused before anything shows.
    // SAFETY: `object` is the live web view retained above.
    let outside = unsafe { look_up_in(object, "word", 10_000.0, 10_000.0, &style) };
    if outside != Err("E_LOOK_UP_OUTSIDE_VIEW") {
        return Err("E_LOOK_UP_OUTSIDE_NOT_REFUSED");
    }
    // Something that is not a web view has none of it, and says so.
    // SAFETY: an NSObject is live and responds to respondsToSelector:.
    let plain: Retained<objc2_foundation::NSObject> = objc2_foundation::NSObject::new();
    let plain_object = Retained::as_ptr(&plain).cast::<AnyObject>().cast_mut();
    // SAFETY: `plain_object` is the live object retained above.
    if unsafe { look_up_in(plain_object, "word", 1.0, 1.0, &style) } != Err("E_LOOK_UP_UNAVAILABLE")
    {
        return Err("E_LOOK_UP_NOT_GUARDED");
    }
    // SAFETY: as above; stopping speech with nothing speaking is harmless.
    if unsafe { speak_in(plain_object, false, None) }.is_err() {
        return Err("E_SPEECH_STOP_NOT_GUARDED");
    }
    // SAFETY: as above.
    if unsafe { speak_in(plain_object, true, None) } != Err("E_SPEECH_NOTHING_TO_SAY") {
        return Err("E_SPEECH_START_NOT_GUARDED");
    }
    Ok(())
}

/// Main thread only.
#[doc(hidden)]
pub fn self_test_look_up_fonts() -> Result<(), &'static str> {
    use super::{FontSource, LookUpFont, look_up_style};
    MainThreadMarker::new().ok_or("E_NATIVE_NOT_MAIN_THREAD")?;
    let font = |family: &str, weight: f64, italic: bool, file: Option<Vec<u8>>| {
        let request = LookUpFont {
            family: family.to_string(),
            size: 21.0,
            weight,
            italic,
        };
        look_up_font(&look_up_style(Some(&request), |_| file.clone()))
    };
    let family = |font: &NSFont| font.familyName().map(|name| name.to_string());
    let traits = |font: &NSFont| {
        let mtm = MainThreadMarker::new().expect("main thread");
        NSFontManager::sharedFontManager(mtm).traitsOfFont(font)
    };
    let menlo = font("Menlo, monospace", 400.0, false, None);
    if family(&menlo).as_deref() != Some("Menlo") || menlo.pointSize() != 21.0 {
        return Err("E_LOOK_UP_FONT_INSTALLED");
    }
    let bold_italic = font("\"Menlo\"", 700.0, true, None);
    let wanted = NSFontTraitMask::BoldFontMask | NSFontTraitMask::ItalicFontMask;
    if !traits(&bold_italic).contains(wanted) {
        return Err("E_LOOK_UP_FONT_TRAITS");
    }
    let system = NSFont::systemFontOfSize(21.0);
    for list in [
        "-apple-system",
        "No Such Font Family",
        "\"Devot Font Gone ttf\"",
    ] {
        if family(&font(list, 400.0, false, None)) != family(&system) {
            return Err("E_LOOK_UP_FONT_FALLBACK");
        }
    }
    let mono = NSFont::monospacedSystemFontOfSize_weight(21.0, symbol_weight("regular"));
    if family(&font("ui-monospace, Menlo", 400.0, false, None)) != family(&mono) {
        return Err("E_LOOK_UP_FONT_MONOSPACED");
    }
    // Bytes that are not a font fall through to the next family.
    let garbage = font(
        "\"Devot Font X ttf\", Menlo",
        400.0,
        false,
        Some(vec![0; 64]),
    );
    if family(&garbage).as_deref() != Some("Menlo") {
        return Err("E_LOOK_UP_FONT_FILE_INVALID");
    }
    if let Ok(bytes) = std::fs::read("/System/Library/Fonts/Menlo.ttc") {
        let from_file = look_up_font(&super::LookUpStyle {
            sources: vec![FontSource::File(bytes.clone())],
            ..look_up_style(None, |_| None)
        });
        if family(&from_file).as_deref() != Some("Menlo") {
            return Err("E_LOOK_UP_FONT_FILE");
        }
        let bold_italic = font("\"Devot Font Menlo ttf\"", 700.0, true, Some(bytes.clone()));
        if family(&bold_italic).as_deref() != Some("Menlo")
            || !traits(&bold_italic).contains(wanted)
        {
            return Err("E_LOOK_UP_FONT_FILE_FACE");
        }
        let regular = font("\"Devot Font Menlo ttf\"", 400.0, false, Some(bytes));
        if traits(&regular).intersects(wanted) {
            return Err("E_LOOK_UP_FONT_FILE_FACE");
        }
    }
    Ok(())
}

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
use std::path::Path;

use crate::page_setup::{Fields, Margins, MarkPlaces, PageLayout, PageSetup, Paper, Rgba, expand};
use objc2_app_kit::{
    NSFontAttributeName, NSForegroundColorAttributeName, NSGraphicsContext, NSLineBreakMode,
    NSMutableParagraphStyle, NSPaperOrientation, NSParagraphStyleAttributeName, NSTextAlignment,
};
use objc2_core_foundation::{CFRetained, CFString, CFURL, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGContext, CGPDFContextAddDestinationAtPoint, CGPDFContextClose, CGPDFContextCreateWithURL,
    CGPDFContextSetDestinationForRect, CGPDFContextSetURLForRect,
};
use objc2_foundation::{NSDate, NSDateFormatter, NSDateFormatterStyle, NSLocale};
use objc2_pdf_kit::{PDFActionGoTo, PDFActionURL, PDFDisplayBox, PDFDocument, PDFPrintScalingMode};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrintTarget {
    Printer,
    Pdf(std::path::PathBuf),
}

impl PrintTarget {
    /// A print through the panel either printed or was cancelled there; a PDF has no panel to
    /// cancel, so a PDF that was not written failed.
    pub fn outcome(&self, success: bool) -> Result<bool, &'static str> {
        match (self, success) {
            (_, true) => Ok(true),
            (PrintTarget::Printer, false) => Ok(false),
            (PrintTarget::Pdf(_), false) => Err("E_EXPORT_PDF_FAILED"),
        }
    }
}

/// Whether it printed (false when the user cancelled the panel), or an error code.
pub type PrintDone = Box<dyn FnOnce(Result<bool, &'static str>)>;

const PRINT_LOAD_TIMEOUT: f64 = 60.0;

/// So printing, like the preview, never fetches an image from the web: no server learns that a note
/// was printed, and no slow host holds the job up. The UI gives its pages to print the same policy
/// (`PRINT_CSP` in src/core/htmlExport.ts).
pub const PRINT_POLICY: &str = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/// Nothing in the page comes before the policy, so it applies to every load the page asks for, and
/// the page's own policy can only narrow it further (every policy applies).
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
    paper: Paper,
    margins: Margins,
    /// The page is still loading: its load starts printing, and a load
    /// failure ends the job. False once printing has begun (from then on
    /// only the print operation ends the job) or the job is over.
    loading: Cell<bool>,
    title: String,
    window: Weak<NSWindow>,
    done: RefCell<Option<PrintDone>>,
    web_view: RefCell<Option<Retained<WKWebView>>>,
    document: RefCell<Option<Retained<PDFDocument>>>,
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
        /// AppKit calls it on the thread the operation printed on, which is not the main thread
        /// when the operation ran on a thread of its own (WebKit's print operations may, and a
        /// PDF's does), so it touches nothing of the job's and hands `success` to the main thread,
        /// where the job ends.
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

        #[unsafe(method(printOperationEnded:))]
        fn print_operation_ended(&self, success: &NSNumber) {
            self.finish(self.ivars().target.outcome(success.boolValue()));
        }

        #[unsafe(method(loadTimedOut))]
        fn load_timed_out(&self) {
            self.load_failed("E_PRINT_TIMEOUT");
        }

        #[unsafe(method(releaseWebView))]
        fn release_web_view(&self) {
            self.ivars().web_view.take();
            self.ivars().document.take();
        }
    }
);

thread_local! {
    static PRINT_JOBS: RefCell<Vec<Retained<PrintJob>>> = const { RefCell::new(Vec::new()) };
}

impl PrintJob {
    fn print(&self, web_view: &WKWebView) {
        if !self.ivars().loading.replace(false) {
            return;
        }
        let Some(window) = self.ivars().window.load() else {
            self.finish(Err("E_PRINT_NO_WINDOW"));
            return;
        };
        let info = print_info(self.ivars().paper, self.ivars().margins.points());
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

    /// When it is printing already, AppKit holds the job as the print operation's delegate (without
    /// retaining it) until `didRunSelector`, which ends it; ending it here would free it under
    /// AppKit.
    fn load_failed(&self, code: &'static str) {
        if self.ivars().loading.get() {
            self.finish(Err(code));
        }
    }

    /// Runs on the main thread, as every path that ends a job does.
    fn finish(&self, result: Result<bool, &'static str>) {
        let Some(done) = self.ivars().done.take() else {
            return;
        };
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

fn print_info(paper: Paper, margin: f64) -> Retained<NSPrintInfo> {
    let info = NSPrintInfo::sharedPrintInfo().copy();
    let (width, height) = paper.size();
    info.setOrientation(if width > height {
        NSPaperOrientation::Landscape
    } else {
        NSPaperOrientation::Portrait
    });
    info.setPaperSize(NSSize::new(width, height));
    info.setTopMargin(margin);
    info.setBottomMargin(margin);
    info.setLeftMargin(margin);
    info.setRightMargin(margin);
    info
}

fn print_job(mtm: MainThreadMarker, state: PrintJobState) -> Retained<PrintJob> {
    let job = PrintJob::alloc(mtm).set_ivars(state);
    // SAFETY: NSObject's `init` on a freshly allocated subclass instance.
    let job: Retained<PrintJob> = unsafe { msg_send![super(job), init] };
    PRINT_JOBS.with(|jobs| jobs.borrow_mut().push(job.clone()));
    job
}

fn print_busy() -> bool {
    PRINT_JOBS.with(|jobs| !jobs.borrow().is_empty())
}

/// Lays `html` out in an offscreen web view (scripts off, nothing loaded from elsewhere: see
/// `with_print_policy`) on `paper` with `margins` and prints it to the print panel as a sheet on
/// `window`, or to a PDF file without a panel. `done` runs once on the main thread. One job runs
/// at a time.
#[allow(clippy::too_many_arguments)]
pub fn print_html(
    mtm: MainThreadMarker,
    window: &NSWindow,
    html: &str,
    title: &str,
    target: PrintTarget,
    paper: Paper,
    margins: Margins,
    done: PrintDone,
) {
    if print_busy() {
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
    let (width, height) = paper.size();
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height));
    // SAFETY: a fresh allocation initialised with a valid configuration.
    let web_view =
        unsafe { WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &config) };
    let job = print_job(
        mtm,
        PrintJobState {
            target,
            paper,
            margins,
            loading: Cell::new(true),
            title: title.to_owned(),
            window: Weak::new(window),
            done: RefCell::new(Some(done)),
            web_view: RefCell::new(Some(web_view.clone())),
            document: RefCell::new(None),
        },
    );
    let page = NSString::from_str(&with_print_policy(html));
    // SAFETY: the web view's delegate is weak; the job is kept alive in
    // PRINT_JOBS until `finish`, and then by its pending `releaseWebView`
    // call, which drops the web view; the HTML string is copied by WebKit.
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

/// Prints the PDF at `path` through the print panel, as a sheet on
/// `window`, each page scaled down to the paper the user picks if it does
/// not fit. `done` runs once on the main thread: true when it printed,
/// false when the user cancelled.
fn print_pdf(
    mtm: MainThreadMarker,
    window: &NSWindow,
    path: &Path,
    title: &str,
    paper: Paper,
    done: PrintDone,
) {
    if print_busy() {
        done(Err("E_PRINT_BUSY"));
        return;
    }
    let Some(url) = file_url(path) else {
        done(Err("E_PRINT_PATH_INVALID"));
        return;
    };
    // SAFETY: a fresh allocation initialised from a file URL.
    let Some(document) = (unsafe { PDFDocument::initWithURL(PDFDocument::alloc(), &url) }) else {
        done(Err("E_PRINT_LOAD_FAILED"));
        return;
    };
    let info = print_info(paper, 0.0);
    // SAFETY: the document and the print info are live; the scaling mode is
    // one of PDFKit's own.
    let operation = unsafe {
        document.printOperationForPrintInfo_scalingMode_autoRotate(
            Some(&info),
            PDFPrintScalingMode::PageScaleDownToFit,
            true,
            mtm,
        )
    };
    let Some(operation) = operation else {
        done(Err("E_PRINT_FAILED"));
        return;
    };
    operation.setShowsPrintPanel(true);
    operation.setShowsProgressPanel(true);
    operation.setJobTitle(Some(&NSString::from_str(title)));
    let job = print_job(
        mtm,
        PrintJobState {
            target: PrintTarget::Printer,
            paper,
            margins: Margins::Normal,
            loading: Cell::new(false),
            title: title.to_owned(),
            window: Weak::new(window),
            done: RefCell::new(Some(done)),
            web_view: RefCell::new(None),
            document: RefCell::new(Some(document)),
        },
    );
    // SAFETY: as in `PrintJob::print`: the job implements the selector and
    // stays in PRINT_JOBS until it has run.
    unsafe {
        operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            window,
            Some(job.as_ref()),
            Some(sel!(printOperationDidRun:success:contextInfo:)),
            std::ptr::null_mut(),
        );
    }
}

fn file_url(path: &Path) -> Option<Retained<NSURL>> {
    path.to_str()
        .map(|path| NSURL::fileURLWithPath(&NSString::from_str(path)))
}

/// Prints a note's page with its page setup. WebKit draws no CSS page-margin boxes, so it lays the
/// page out into a PDF in `work`, whose pages `stamp_pdf` draws again with the header and footer:
/// into a PDF target's file, or into one more PDF in `work` that the print panel prints.
pub fn print_note(
    mtm: MainThreadMarker,
    window: &NSWindow,
    html: &str,
    layout: PageLayout,
    target: PrintTarget,
    work: &Path,
    done: PrintDone,
) {
    let laid_out = work.join("layout.pdf");
    let out = match &target {
        PrintTarget::Pdf(path) => path.clone(),
        PrintTarget::Printer => work.join("print.pdf"),
    };
    let window = objc2::Message::retain(window);
    let source = laid_out.clone();
    let PageSetup { paper, margins, .. } = layout.setup;
    let title = layout.title.clone();
    print_html(
        mtm,
        &window.clone(),
        html,
        &title,
        PrintTarget::Pdf(laid_out),
        paper,
        margins,
        Box::new(move |result| {
            if let Err(code) = result.and_then(|_| stamp_pdf(&source, &out, &layout)) {
                return done(Err(code));
            }
            match target {
                PrintTarget::Pdf(_) => done(Ok(true)),
                PrintTarget::Printer => print_pdf(mtm, &window, &out, &layout.title, paper, done),
            }
        }),
    );
}

fn ns_window(app: &tauri::AppHandle, label: &str) -> Option<Retained<NSWindow>> {
    let window = app
        .get_webview_window(label)
        .and_then(|window| window.ns_window().ok())
        .filter(|window| !window.is_null())?;
    // SAFETY: `ns_window()` returns the window's live NSWindow (checked non-null above); retaining
    // it keeps it alive for the caller.
    unsafe { Retained::retain(window.cast::<NSWindow>()) }
}

/// `print_html` on the system's paper, as the command-line export prints. Must run on the main
/// thread.
pub fn print_in_window(
    app: &tauri::AppHandle,
    label: &str,
    html: &str,
    title: &str,
    target: PrintTarget,
    done: PrintDone,
) {
    let Some(mtm) = MainThreadMarker::new() else {
        done(Err("E_NATIVE_NOT_MAIN_THREAD"));
        return;
    };
    let Some(window) = ns_window(app, label) else {
        done(Err("E_PRINT_NO_WINDOW"));
        return;
    };
    print_html(
        mtm,
        &window,
        html,
        title,
        target,
        system_paper(),
        Margins::Narrow,
        done,
    );
}

/// `print_note` in the window `label`. Must run on the main thread.
pub fn print_note_in_window(
    app: &tauri::AppHandle,
    label: &str,
    html: &str,
    layout: PageLayout,
    target: PrintTarget,
    work: &Path,
    done: PrintDone,
) {
    let Some(mtm) = MainThreadMarker::new() else {
        done(Err("E_NATIVE_NOT_MAIN_THREAD"));
        return;
    };
    let Some(window) = ns_window(app, label) else {
        done(Err("E_PRINT_NO_WINDOW"));
        return;
    };
    print_note(mtm, &window, html, layout, target, work, done);
}

/// The paper a page setup starts with: the system's default paper, or the
/// region's (`page_setup::default_paper`).
pub fn system_paper() -> Paper {
    let width = NSPrintInfo::sharedPrintInfo().paperSize().width;
    let region = NSLocale::currentLocale()
        .regionCode()
        .map(|code| code.to_string());
    crate::page_setup::default_paper(Some(width), region.as_deref())
}

fn today() -> String {
    let formatter = NSDateFormatter::new();
    formatter.setDateStyle(NSDateFormatterStyle::MediumStyle);
    formatter.setTimeStyle(NSDateFormatterStyle::NoStyle);
    formatter.stringFromDate(&NSDate::now()).to_string()
}

/// A link on a laid-out page, to keep on the page drawn again.
enum PageLink {
    Url(NSRect, Retained<NSURL>),
    /// To a point on a page (by index), by the destination's name.
    Page(NSRect, String),
}

type LinkTarget = (String, NSPoint);

/// Each page's links, and the named points on each page they go to.
fn page_links(document: &PDFDocument, pages: usize) -> (Vec<Vec<PageLink>>, Vec<Vec<LinkTarget>>) {
    let mut links: Vec<Vec<PageLink>> = (0..pages).map(|_| Vec::new()).collect();
    let mut targets: Vec<Vec<LinkTarget>> = (0..pages).map(|_| Vec::new()).collect();
    for (index, on_page) in links.iter_mut().enumerate() {
        // SAFETY: `index` is below the document's page count.
        let Some(page) = (unsafe { document.pageAtIndex(index) }) else {
            continue;
        };
        // SAFETY: plain property reads on live PDFKit objects; a GoTo
        // action is checked by class before it is used as one.
        unsafe {
            for annotation in page.annotations().iter() {
                let rect = annotation.bounds();
                let action = annotation.action();
                let url = annotation.URL().or_else(|| {
                    action
                        .as_ref()
                        .and_then(|a| a.downcast_ref::<PDFActionURL>())
                        .and_then(|a| a.URL())
                });
                if let Some(url) = url {
                    on_page.push(PageLink::Url(rect, url));
                    continue;
                }
                let destination = annotation.destination().or_else(|| {
                    action
                        .as_ref()
                        .and_then(|a| a.downcast_ref::<PDFActionGoTo>())
                        .map(|a| a.destination())
                });
                let Some(destination) = destination else {
                    continue;
                };
                let Some(to) = destination.page() else {
                    continue;
                };
                let to_index = document.indexForPage(&to);
                if to_index >= pages {
                    continue;
                }
                let bounds = to.boundsForBox(PDFDisplayBox::MediaBox);
                let point = destination.point();
                // An unspecified coordinate is a huge number: the page's top left.
                let point = NSPoint::new(
                    if point.x <= bounds.size.width {
                        point.x
                    } else {
                        0.0
                    },
                    if point.y <= bounds.size.height {
                        point.y
                    } else {
                        bounds.size.height
                    },
                );
                let name = format!("devot-{index}-{}", on_page.len());
                targets[to_index].push((name.clone(), point));
                on_page.push(PageLink::Page(rect, name));
            }
        }
    }
    (links, targets)
}

fn cf_string(text: &str) -> CFRetained<CFString> {
    CFString::from_str(text)
}

/// Draws the PDF at `source` again into `out` with the header and footer
/// of `layout`, keeping its links. Runs on the main thread (AppKit draws
/// the text).
pub fn stamp_pdf(source: &Path, out: &Path, layout: &PageLayout) -> Result<(), &'static str> {
    MainThreadMarker::new().ok_or("E_NATIVE_NOT_MAIN_THREAD")?;
    let url = file_url(source).ok_or("E_PRINT_PATH_INVALID")?;
    // SAFETY: a fresh allocation initialised from a file URL.
    let document = unsafe { PDFDocument::initWithURL(PDFDocument::alloc(), &url) }
        .ok_or("E_PRINT_STAMP_READ_FAILED")?;
    // SAFETY: a plain property read.
    let pages = unsafe { document.pageCount() };
    if pages == 0 {
        return Err("E_PRINT_STAMP_READ_FAILED");
    }
    let out_url = file_url(out).ok_or("E_PRINT_PATH_INVALID")?;
    // SAFETY: NSURL and CFURL are toll-free bridged: the same object.
    let out_url: &CFURL = unsafe { &*(Retained::as_ptr(&out_url).cast::<CFURL>()) };
    // SAFETY: a valid file URL; no media box (each page gives its own) and
    // no extra info.
    let context = unsafe { CGPDFContextCreateWithURL(Some(out_url), std::ptr::null(), None) }
        .ok_or("E_PRINT_STAMP_WRITE_FAILED")?;
    let (links, targets) = page_links(&document, pages);
    let date = today();
    let places = MarkPlaces::new(layout.setup.paper, layout.setup.margins);
    for index in 0..pages {
        // SAFETY: `index` is below the page count.
        let Some(page) = (unsafe { document.pageAtIndex(index) }) else {
            continue;
        };
        // SAFETY: a plain property read.
        let bounds = unsafe { page.boundsForBox(PDFDisplayBox::MediaBox) };
        let media = CGRect::new(
            CGPoint::new(0.0, 0.0),
            CGSize::new(bounds.size.width, bounds.size.height),
        );
        // SAFETY: `media` lives for the call; the page is drawn into the
        // context it began.
        unsafe {
            CGContext::begin_page(Some(&context), &media);
            page.drawWithBox_toContext(PDFDisplayBox::MediaBox, &context);
        }
        for (name, point) in &targets[index] {
            CGPDFContextAddDestinationAtPoint(Some(&context), &cf_string(name), *point);
        }
        for link in &links[index] {
            match link {
                PageLink::Url(rect, url) => {
                    // SAFETY: as above, toll-free bridged.
                    let url: &CFURL = unsafe { &*(Retained::as_ptr(url).cast::<CFURL>()) };
                    CGPDFContextSetURLForRect(Some(&context), url, *rect);
                }
                PageLink::Page(rect, name) => {
                    CGPDFContextSetDestinationForRect(Some(&context), &cf_string(name), *rect);
                }
            }
        }
        if !(layout.setup.skip_first && index == 0) {
            let fields = Fields {
                title: &layout.title,
                date: &date,
                page: index + 1,
                total: pages,
            };
            draw_marks(&context, layout, &places, &fields);
        }
        CGContext::end_page(Some(&context));
    }
    CGPDFContextClose(Some(&context));
    Ok(())
}

fn ns_color(c: &Rgba) -> Retained<NSColor> {
    NSColor::colorWithSRGBRed_green_blue_alpha(c.r, c.g, c.b, c.a)
}

fn draw_marks(context: &CGContext, layout: &PageLayout, places: &MarkPlaces, fields: &Fields) {
    let setup = &layout.setup;
    let look = &layout.look;
    let graphics = NSGraphicsContext::graphicsContextWithCGContext_flipped(context, false);
    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&graphics));
    let font = NSFont::systemFontOfSize(look.font_size);
    let color = ns_color(&look.text);
    let line = look.font_size * 1.5;
    let third = (places.right - places.left) / 3.0;
    for (slots, centre, rule_y) in [
        (&setup.header, places.header_y, places.header_rule_y),
        (&setup.footer, places.footer_y, places.footer_rule_y),
    ] {
        if slots.iter().all(String::is_empty) {
            continue;
        }
        for (i, (template, alignment)) in slots
            .iter()
            .zip([
                NSTextAlignment::Left,
                NSTextAlignment::Center,
                NSTextAlignment::Right,
            ])
            .enumerate()
        {
            let text = expand(template, fields);
            if text.is_empty() {
                continue;
            }
            let style = NSMutableParagraphStyle::new();
            style.setAlignment(alignment);
            style.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
            // SAFETY: AppKit's attribute name constants, valid for the life
            // of the process.
            let keys = unsafe {
                [
                    NSFontAttributeName,
                    NSForegroundColorAttributeName,
                    NSParagraphStyleAttributeName,
                ]
            };
            let values: [&AnyObject; 3] = [font.as_ref(), color.as_ref(), style.as_ref()];
            let attributes = NSDictionary::<NSString, AnyObject>::from_slices(&keys, &values);
            let rect = NSRect::new(
                NSPoint::new(places.left + third * i as f64, centre - line / 2.0),
                NSSize::new(third, line),
            );
            // SAFETY: `drawInRect:withAttributes:` draws into the current
            // context, set above; the attributes map AppKit's keys to values
            // of their types.
            unsafe {
                let _: () = msg_send![
                    &*NSString::from_str(&text),
                    drawInRect: rect,
                    withAttributes: &*attributes
                ];
            }
        }
        if setup.rules {
            let r = &look.rule;
            CGContext::set_rgb_stroke_color(Some(context), r.r, r.g, r.b, r.a);
            CGContext::set_line_width(Some(context), 0.5);
            CGContext::move_to_point(Some(context), places.left, rule_y);
            CGContext::add_line_to_point(Some(context), places.right, rule_y);
            CGContext::stroke_path(Some(context));
        }
    }
    NSGraphicsContext::restoreGraphicsState_class();
}

#[doc(hidden)]
pub fn self_test_print_to_pdf(html: &str, path: &std::path::Path) -> Result<(), &'static str> {
    self_test_print(|mtm, window, done| {
        print_html(
            mtm,
            window,
            html,
            "Devot",
            PrintTarget::Pdf(path.to_owned()),
            Paper::Letter,
            Margins::Narrow,
            done,
        )
    })
}

/// Prints `html` to a PDF file at `path` as Export as PDF does, through
/// `print_note` with `layout`, its files on the way in `path`'s folder.
/// For the main-thread tests.
#[doc(hidden)]
pub fn self_test_print_note_to_pdf(
    html: &str,
    layout: PageLayout,
    path: &Path,
) -> Result<(), &'static str> {
    let work = path.parent().ok_or("E_PRINT_PATH_INVALID")?;
    self_test_print(|mtm, window, done| {
        print_note(
            mtm,
            window,
            html,
            layout,
            PrintTarget::Pdf(path.to_owned()),
            work,
            done,
        )
    })
}

/// A PDF page as a test checks it: its size, its text and its links (the
/// URLs, and the page each link inside the document goes to).
#[doc(hidden)]
#[derive(Debug)]
pub struct SelfTestPage {
    pub width: f64,
    pub height: f64,
    pub text: String,
    pub urls: Vec<String>,
    pub to_pages: Vec<usize>,
}

/// The pages of the PDF at `path`, read through PDFKit. For the
/// main-thread tests.
#[doc(hidden)]
pub fn self_test_pdf_pages(path: &Path) -> Result<Vec<SelfTestPage>, &'static str> {
    let url = file_url(path).ok_or("E_PRINT_PATH_INVALID")?;
    // SAFETY: a fresh allocation initialised from a file URL.
    let document = unsafe { PDFDocument::initWithURL(PDFDocument::alloc(), &url) }
        .ok_or("E_PRINT_STAMP_READ_FAILED")?;
    // SAFETY: a plain property read.
    let count = unsafe { document.pageCount() };
    let mut pages = Vec::with_capacity(count);
    for index in 0..count {
        // SAFETY: `index` is below the page count; plain property reads.
        unsafe {
            let page = document
                .pageAtIndex(index)
                .ok_or("E_PRINT_STAMP_READ_FAILED")?;
            let bounds = page.boundsForBox(PDFDisplayBox::MediaBox);
            let mut out = SelfTestPage {
                width: bounds.size.width,
                height: bounds.size.height,
                text: page.string().map(|s| s.to_string()).unwrap_or_default(),
                urls: Vec::new(),
                to_pages: Vec::new(),
            };
            for annotation in page.annotations().iter() {
                if let Some(url) = annotation.URL() {
                    out.urls.push(
                        url.absoluteString()
                            .map(|s| s.to_string())
                            .unwrap_or_default(),
                    );
                } else if let Some(to) = annotation.destination().and_then(|d| d.page()) {
                    out.to_pages.push(document.indexForPage(&to));
                }
            }
            pages.push(out);
        }
    }
    Ok(pages)
}

/// Runs a print job that `start` begins, with an offscreen window as the
/// parent, running the run loop until it is done.
fn self_test_print(
    start: impl FnOnce(MainThreadMarker, &NSWindow, PrintDone),
) -> Result<(), &'static str> {
    use objc2_foundation::{NSDefaultRunLoopMode, NSRunLoop};
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
    start(
        mtm,
        &window,
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

#[doc(hidden)]
pub fn self_test_print_jobs() -> usize {
    PRINT_JOBS.with(|jobs| jobs.borrow().len())
}

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

struct Before {
    abort: libc::sigaction,
    count: usize,
    masks: [mach2::exception_types::exception_mask_t; EXCEPTION_TYPES],
    ports: [mach2::port::mach_port_t; EXCEPTION_TYPES],
    behaviors: [mach2::exception_types::exception_behavior_t; EXCEPTION_TYPES],
    flavors: [mach2::thread_status::thread_state_flavor_t; EXCEPTION_TYPES],
}

static BEFORE: std::sync::OnceLock<Before> = std::sync::OnceLock::new();
static HANDLER_ABORT: std::sync::OnceLock<libc::sigaction> = std::sync::OnceLock::new();

pub struct CrashHandler {
    _handler: crash_handler::CrashHandler,
}

/// `on_crash` runs on the handler's own thread while every other thread is suspended; it returns
/// whether the crash was handed to the crash reporter. Once a crash has been reported the process
/// ends as it would have without the handler: a Mach exception goes on to the handlers that were
/// there before, and a `SIGABRT` is raised again under the action that was there before. One
/// handler per process; it is never attached again (`detach_crash_handler`).
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

/// The `SIGABRT` action and the exception ports go back to what they were before it was attached,
/// so a crash takes the system's default course. Safe to call more than once, and from a signal
/// handler (it only makes system calls). The handler's own thread stays, idle. Returns whether
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

/// Hands the crash to `crash_handler` (which waits for the reporter), then detaches and raises the
/// signal again. The signal stays blocked until this returns, so it is then taken by the action
/// from before: by default, the process ends with `SIGABRT`.
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

/// `CLOCK_MONOTONIC` keeps counting while the Mac sleeps (`Instant` is `CLOCK_UPTIME_RAW`, which
/// stops), and setting the time does not move it. `None` if the call fails.
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

use objc2_app_kit::{NSAlert, NSAlertStyle};

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

use super::{EditorMenuEntry, EditorMenuPick, KeyEquivalent, SystemItem};
use crate::strings;
use objc2::runtime::Sel;
use objc2_app_kit::{NSControlStateValueOn, NSMenuItem, NSSpellChecker, NSView};

const MAX_SPELLING_GUESSES: usize = 8;

enum MenuChoice {
    Item(String),
    Guess(String),
    Learn,
}

thread_local! {
    static EDITOR_MENU_PICK: Cell<Option<isize>> = const { Cell::new(None) };
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and
    // `EditorMenuTarget` implements no `Drop`.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DevotEditorMenuTarget"]
    struct EditorMenuTarget;

    // SAFETY: NSObjectProtocol has no requirements beyond NSObject's.
    unsafe impl NSObjectProtocol for EditorMenuTarget {}

    impl EditorMenuTarget {
        #[unsafe(method(pick:))]
        fn pick(&self, sender: &NSMenuItem) {
            EDITOR_MENU_PICK.with(|pick| pick.set(Some(sender.tag())));
        }
    }
);

struct EditorMenuBuilder<'a> {
    mtm: MainThreadMarker,
    target: &'a EditorMenuTarget,
    choices: Vec<MenuChoice>,
}

impl EditorMenuBuilder<'_> {
    fn item(&self, title: &str, action: Option<Sel>, key: &str) -> Retained<NSMenuItem> {
        // SAFETY: a fresh allocation; the title, action and key are valid.
        unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                self.mtm.alloc(),
                &NSString::from_str(title),
                action,
                &NSString::from_str(key),
            )
        }
    }

    fn choice(&mut self, title: &str, choice: MenuChoice) -> Retained<NSMenuItem> {
        let item = self.item(title, Some(sel!(pick:)), "");
        item.setTag(self.choices.len() as isize);
        // SAFETY: the target answers `pick:` and outlives the menu: the
        // caller keeps it until the menu has closed.
        unsafe { item.setTarget(Some(self.target)) };
        self.choices.push(choice);
        item
    }

    fn separator(&self) -> Retained<NSMenuItem> {
        NSMenuItem::separatorItem(self.mtm)
    }

    fn add_entries(&mut self, menu: &NSMenu, entries: &[EditorMenuEntry]) {
        for entry in entries {
            match entry {
                EditorMenuEntry::Separator => menu.addItem(&self.separator()),
                EditorMenuEntry::Predefined { item } => {
                    let (title, action, key) = match item {
                        SystemItem::Cut => (strings::EDIT_CUT, sel!(cut:), "x"),
                        SystemItem::Copy => (strings::EDIT_COPY, sel!(copy:), "c"),
                        SystemItem::Paste => (strings::EDIT_PASTE, sel!(paste:), "v"),
                        SystemItem::SelectAll => (strings::EDIT_SELECT_ALL, sel!(selectAll:), "a"),
                    };
                    menu.addItem(&self.item(title, Some(action), key));
                }
                EditorMenuEntry::Item {
                    id,
                    text,
                    accelerator,
                    checked,
                } => {
                    let item = self.choice(text, MenuChoice::Item(id.clone()));
                    if let Some(key) = accelerator.as_deref().and_then(super::key_equivalent) {
                        item.setKeyEquivalent(&NSString::from_str(&key.key));
                        item.setKeyEquivalentModifierMask(modifier_flags(&key));
                    }
                    if *checked == Some(true) {
                        item.setState(NSControlStateValueOn);
                    }
                    menu.addItem(&item);
                }
                EditorMenuEntry::Submenu { text, items, .. } => {
                    let item = self.item(text, None, "");
                    let submenu = NSMenu::new(self.mtm);
                    self.add_entries(&submenu, items);
                    item.setSubmenu(Some(&submenu));
                    menu.addItem(&item);
                }
            }
        }
    }

    fn add_spelling_guesses(&mut self, menu: &NSMenu, word: &str) {
        let Some(guesses) = spelling_guesses(word) else {
            return;
        };
        if guesses.is_empty() {
            menu.addItem(&self.item(strings::SPELLING_NO_GUESSES, None, ""));
        }
        for guess in guesses {
            let item = self.choice(&guess, MenuChoice::Guess(guess.clone()));
            menu.addItem(&item);
        }
        menu.addItem(&self.separator());
        let learn = self.choice(strings::SPELLING_LEARN, MenuChoice::Learn);
        menu.addItem(&learn);
        menu.addItem(&self.separator());
    }

    fn spelling_menu(&self) -> Retained<NSMenuItem> {
        let submenu = NSMenu::new(self.mtm);
        submenu.addItem(&self.item(
            strings::SPELLING_SHOW_PANEL,
            Some(sel!(showGuessPanel:)),
            "",
        ));
        submenu.addItem(&self.item(strings::SPELLING_CHECK_NOW, Some(sel!(checkSpelling:)), ""));
        submenu.addItem(&self.separator());
        for (title, action) in [
            (
                strings::SPELLING_WHILE_TYPING,
                sel!(toggleContinuousSpellChecking:),
            ),
            (strings::SPELLING_GRAMMAR, sel!(toggleGrammarChecking:)),
            (
                strings::SPELLING_CORRECT_AUTOMATICALLY,
                sel!(toggleAutomaticSpellingCorrection:),
            ),
        ] {
            submenu.addItem(&self.item(title, Some(action), ""));
        }
        let item = self.item(strings::MENU_SPELLING, None, "");
        item.setSubmenu(Some(&submenu));
        item
    }
}

fn modifier_flags(key: &KeyEquivalent) -> NSEventModifierFlags {
    let mut flags = NSEventModifierFlags::empty();
    for (on, flag) in [
        (key.command, NSEventModifierFlags::Command),
        (key.shift, NSEventModifierFlags::Shift),
        (key.option, NSEventModifierFlags::Option),
        (key.control, NSEventModifierFlags::Control),
    ] {
        if on {
            flags |= flag;
        }
    }
    flags
}

fn spelling_guesses(word: &str) -> Option<Vec<String>> {
    let checker = NSSpellChecker::sharedSpellChecker();
    let string = NSString::from_str(word);
    let range = checker.checkSpellingOfString_startingAt(&string, 0);
    if range.length == 0 {
        return None;
    }
    let guesses = checker
        .guessesForWordRange_inString_language_inSpellDocumentWithTag(range, &string, None, 0);
    Some(
        guesses
            .map(|guesses| {
                guesses
                    .to_vec()
                    .iter()
                    .take(MAX_SPELLING_GUESSES)
                    .map(|guess| guess.to_string())
                    .collect()
            })
            .unwrap_or_default(),
    )
}

pub fn editor_menu(
    webview: &tauri::webview::PlatformWebview,
    entries: &[EditorMenuEntry],
    x: f64,
    y: f64,
    word: Option<&str>,
) -> Result<Option<EditorMenuPick>, &'static str> {
    let web_view: *mut AnyObject = webview.inner().cast();
    guarded("W_NATIVE_EDITOR_MENU_FAILED", || {
        let mtm = MainThreadMarker::new()?;
        // SAFETY: `inner()` is the live WKWebView owned by the window (an
        // NSView); the call runs on the main thread (`with_webview`).
        let view = unsafe { web_view.cast::<NSView>().as_ref() }?;
        Some(show_editor_menu(mtm, view, entries, x, y, word))
    })
    .unwrap_or(Err("E_EDITOR_MENU_FAILED"))
}

fn build_editor_menu(
    builder: &mut EditorMenuBuilder<'_>,
    entries: &[EditorMenuEntry],
    word: Option<&str>,
) -> (Retained<NSMenu>, Retained<NSMenu>) {
    let mtm = builder.mtm;
    let menu = NSMenu::new(mtm);
    if let Some(word) = word {
        builder.add_spelling_guesses(&menu, word);
    }
    builder.add_entries(&menu, entries);
    menu.addItem(&builder.separator());
    // SAFETY: the class object is a live NSObject class; asking it answers
    // whether the class method exists on this system.
    let class = (NSMenuItem::class() as *const AnyClass)
        .cast_mut()
        .cast::<AnyObject>();
    if unsafe { responds(class, sel!(writingToolsItems)) } {
        for item in NSMenuItem::writingToolsItems(mtm).to_vec() {
            menu.addItem(&item);
        }
    } else {
        log::warn!("W_NATIVE_WRITING_TOOLS_UNAVAILABLE");
    }
    menu.addItem(&builder.spelling_menu());
    menu.addItem(&builder.separator());
    let services = NSMenu::new(mtm);
    let services_item = builder.item(strings::MENU_SERVICES, None, "");
    services_item.setSubmenu(Some(&services));
    menu.addItem(&services_item);
    (menu, services)
}

/// Puts the app's own Services menu back when dropped, so it comes back
/// however the editor's menu ended (an exception unwinds through it too).
struct RestoreServices {
    app: Retained<NSApplication>,
    menu: Option<Retained<NSMenu>>,
}

impl Drop for RestoreServices {
    fn drop(&mut self) {
        self.app.setServicesMenu(self.menu.as_deref());
    }
}

fn picked_choice(choices: &[MenuChoice]) -> Option<&MenuChoice> {
    EDITOR_MENU_PICK
        .with(Cell::take)
        .and_then(|tag| usize::try_from(tag).ok())
        .and_then(|index| choices.get(index))
}

fn show_editor_menu(
    mtm: MainThreadMarker,
    view: &NSView,
    entries: &[EditorMenuEntry],
    x: f64,
    y: f64,
    word: Option<&str>,
) -> Result<Option<EditorMenuPick>, &'static str> {
    let target = EditorMenuTarget::alloc(mtm).set_ivars(());
    // SAFETY: NSObject's `init` on a freshly allocated subclass instance.
    let target: Retained<EditorMenuTarget> = unsafe { msg_send![super(target), init] };
    let mut builder = EditorMenuBuilder {
        mtm,
        target: &target,
        choices: Vec::new(),
    };
    let (menu, services) = build_editor_menu(&mut builder, entries, word);
    // AppKit fills the app's Services menu with what the first responder's
    // selection can be sent to: this one for as long as the menu is open.
    let app = NSApplication::sharedApplication(mtm);
    let restore = RestoreServices {
        menu: app.servicesMenu(),
        app: app.clone(),
    };
    app.setServicesMenu(Some(&services));
    EDITOR_MENU_PICK.with(|pick| pick.set(None));
    // The item picked has sent its action by the time this returns.
    menu.popUpMenuPositioningItem_atLocation_inView(None, NSPoint::new(x, y), Some(view));
    drop(restore);
    Ok(match picked_choice(&builder.choices) {
        None => None,
        Some(MenuChoice::Item(id)) => Some(EditorMenuPick::Item { id: id.clone() }),
        Some(MenuChoice::Guess(text)) => Some(EditorMenuPick::Guess { text: text.clone() }),
        Some(MenuChoice::Learn) => {
            if let Some(word) = word {
                NSSpellChecker::sharedSpellChecker().learnWord(&NSString::from_str(word));
            }
            None
        }
    })
}

pub fn self_test_editor_menu() -> Result<(), &'static str> {
    let mtm = MainThreadMarker::new().ok_or("E_TEST_NOT_MAIN_THREAD")?;
    let target = EditorMenuTarget::alloc(mtm).set_ivars(());
    // SAFETY: NSObject's `init` on a freshly allocated subclass instance.
    let target: Retained<EditorMenuTarget> = unsafe { msg_send![super(target), init] };
    let entries = [
        EditorMenuEntry::Item {
            id: "devot.editor.undo".into(),
            text: "Undo".into(),
            accelerator: Some("CmdOrCtrl+Z".into()),
            checked: None,
        },
        EditorMenuEntry::Separator,
        EditorMenuEntry::Predefined {
            item: SystemItem::Cut,
        },
    ];
    let titles = |menu: &NSMenu| -> Vec<String> {
        menu.itemArray()
            .to_vec()
            .iter()
            .map(|item| item.title().to_string())
            .collect()
    };
    let mut builder = EditorMenuBuilder {
        mtm,
        target: &target,
        choices: Vec::new(),
    };
    let (menu, _) = build_editor_menu(&mut builder, &entries, Some("recieve"));
    let shown = titles(&menu);
    let undo = shown
        .iter()
        .position(|t| t == "Undo")
        .ok_or("E_TEST_NO_UNDO")?;
    let learn = shown
        .iter()
        .position(|t| t == strings::SPELLING_LEARN)
        .ok_or("E_TEST_NO_LEARN")?;
    if !shown[..learn].iter().any(|t| t == "receive") || learn > undo {
        return Err("E_TEST_NO_GUESS");
    }
    for title in [
        strings::EDIT_CUT,
        strings::MENU_SPELLING,
        strings::MENU_SERVICES,
    ] {
        if !shown.iter().any(|t| t == title) {
            return Err("E_TEST_SYSTEM_ITEM_MISSING");
        }
    }
    if shown.last().map(String::as_str) != Some(strings::MENU_SERVICES) {
        return Err("E_TEST_SERVICES_NOT_LAST");
    }
    let undo_item = menu.itemAtIndex(undo as isize).ok_or("E_TEST_NO_UNDO")?;
    if undo_item.keyEquivalent().to_string() != "z"
        || !undo_item
            .keyEquivalentModifierMask()
            .contains(NSEventModifierFlags::Command)
    {
        return Err("E_TEST_UNDO_KEY");
    }
    menu.performActionForItemAtIndex(undo as isize);
    match picked_choice(&builder.choices) {
        Some(MenuChoice::Item(id)) if id == "devot.editor.undo" => {}
        _ => return Err("E_TEST_PICK_LOST"),
    }
    let mut builder = EditorMenuBuilder {
        mtm,
        target: &target,
        choices: Vec::new(),
    };
    let (menu, _) = build_editor_menu(&mut builder, &entries, Some("the"));
    if titles(&menu).first().map(String::as_str) != Some("Undo") {
        return Err("E_TEST_GUESSES_FOR_A_RIGHT_WORD");
    }
    Ok(())
}

/// The user's own temporary folder (`DARWIN_USER_TEMP_DIR`), the same whatever `TMPDIR` says.
pub fn user_temp_dir() -> Option<std::path::PathBuf> {
    use std::os::unix::ffi::OsStringExt;
    let mut buf = vec![0u8; 1024];
    // SAFETY: `buf` is writable for `buf.len()` bytes, and confstr writes at most that many,
    // the terminating NUL included; it returns the length it needed, NUL included, or 0.
    let needed = unsafe {
        libc::confstr(
            libc::_CS_DARWIN_USER_TEMP_DIR,
            buf.as_mut_ptr().cast(),
            buf.len(),
        )
    };
    if needed < 2 || needed > buf.len() {
        return None;
    }
    buf.truncate(needed - 1);
    Some(std::ffi::OsString::from_vec(buf).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tests that touch WebKit run on the main thread in
    // tests/webkit_main_thread.rs; libtest's worker threads crash WebKit.

    /// A pasteboard of the test's own, so the user's clipboard is never touched.
    struct OwnPasteboard(objc2::rc::Retained<NSPasteboard>);

    impl Drop for OwnPasteboard {
        fn drop(&mut self) {
            // SAFETY: `releaseGlobally` is public AppKit API (macOS 10.0+) on a live pasteboard
            // this test made; it takes no arguments and returns nothing.
            let () = unsafe { msg_send![&*self.0, releaseGlobally] };
        }
    }

    #[test]
    fn a_secret_is_marked_concealed_and_cleared_only_when_nothing_replaced_it() {
        let own = OwnPasteboard(NSPasteboard::pasteboardWithUniqueName());
        let pasteboard = &own.0;
        let count = write_secret_text_to(pasteboard, "secret").expect("written");
        // SAFETY: an immutable AppKit constant (macOS 10.6+).
        let kind = unsafe { NSPasteboardTypeString };
        assert_eq!(
            pasteboard.stringForType(kind).map(|s| s.to_string()),
            Some("secret".to_string())
        );
        let types: Vec<String> = pasteboard
            .types()
            .map(|types| types.iter().map(|t| t.to_string()).collect())
            .unwrap_or_default();
        assert!(types.iter().any(|t| t == CONCEALED_TYPE));
        assert!(types.iter().any(|t| t == TRANSIENT_TYPE));

        assert!(!clear_if_unchanged(pasteboard, count - 1));
        assert!(pasteboard.stringForType(kind).is_some());
        assert!(clear_if_unchanged(pasteboard, count));
        assert!(pasteboard.stringForType(kind).is_none());

        let count = write_secret_text_to(pasteboard, "secret").expect("written");
        pasteboard.clearContents();
        pasteboard.setString_forType(&NSString::from_str("the user's copy"), kind);
        assert!(!clear_if_unchanged(pasteboard, count));
        assert!(pasteboard.stringForType(kind).is_some());
    }

    #[test]
    fn time_since_boot_runs_forward() {
        let first = time_since_boot().expect("clock");
        let then = time_since_boot().expect("clock");
        assert!(first > std::time::Duration::ZERO);
        assert!(then >= first);
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
        let page = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">";
        assert_eq!(
            with_print_policy(page),
            format!("{start}\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">")
        );
        assert_eq!(
            with_print_policy("<img src=\"http://example.com/a.png\">"),
            format!("{start}<img src=\"http://example.com/a.png\">")
        );
        let legacy = "<!DOCTYPE html PUBLIC \"-//W3C//DTD HTML 4.01//EN\"><p>x</p>";
        assert_eq!(with_print_policy(legacy), format!("{start}{legacy}"));
        assert_eq!(with_print_policy(""), start);
        assert!(PRINT_POLICY.contains("default-src 'none'"));
        assert!(PRINT_POLICY.contains("img-src data:;"));
        assert!(!PRINT_POLICY.contains("http"));
    }
}
