//! WebKit's private preferences and features, set per main window's web view.

use objc2::ClassType;
use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::sel;
use objc2_foundation::NSString;

use super::responds;
use crate::native::guarded;

/// Paces page rendering updates near 60 fps by default, even on 120 Hz displays.
const SIXTY_FPS_FEATURE: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";
/// WebRTC, which no content security policy governs: off, so a plugin's frame cannot reach the
/// network through it (ADR 0005).
const PEER_CONNECTION_FEATURE: &str = "PeerConnectionEnabled";
/// A preconnect hint opens a DNS lookup, TCP and TLS the instant the link is inserted, outside any
/// content security policy and before the runtime guard's observer can remove it.
const PRECONNECT_FEATURE: &str = "LinkPreconnect";
/// Resource hints reach the network outside any policy (ADR 0005). Off on every main window, so a
/// hint the runtime guard has not yet removed starts no connection. Any WebKit does not offer is
/// skipped; only preconnect, which connects synchronously, must be present.
const RESOURCE_HINT_FEATURES: &[&str] = &[
    PRECONNECT_FEATURE,
    "LinkPreconnectEarlyHintsEnabled",
    "LinkPreloadEnabled",
    "LinkPrefetchEnabled",
    "SpeculationRulesPrefetchEnabled",
];

/// Per web view: every main window needs it.
pub fn unlock_high_refresh_rate(window: &tauri::WebviewWindow) {
    set_main_window_feature(
        window,
        SIXTY_FPS_FEATURE,
        false,
        "I_NATIVE_HIGH_REFRESH_RATE_ON",
        "W_NATIVE_HIGH_REFRESH_RATE_UNAVAILABLE",
    );
}

/// Per web view: plugins run in every main window.
pub fn turn_off_peer_connections(window: &tauri::WebviewWindow) {
    set_main_window_feature(
        window,
        PEER_CONNECTION_FEATURE,
        false,
        "I_NATIVE_PEER_CONNECTION_OFF",
        "W_NATIVE_PEER_CONNECTION_UNAVAILABLE",
    );
}

/// `WKInactiveSchedulingPolicyNone`: macOS 14 and later.
const INACTIVE_SCHEDULING_NONE: isize = 2;

/// A main window built hidden must answer AI tools (`background`), and WebKit may suspend a page
/// nobody can see. Where the setting does not exist the page runs as a hidden one always has.
pub fn keep_running_while_hidden(window: &tauri::WebviewWindow) {
    let result = window.with_webview(move |webview| {
        let web_view: *mut AnyObject = webview.inner().cast();
        let set = guarded("W_NATIVE_WEB_FEATURE_FAILED", || {
            // SAFETY: `inner()` is the live WKWebView owned by this window, and the setter is
            // checked with respondsToSelector: before use.
            unsafe { set_never_suspended(web_view) }.then_some(())
        })
        .is_some();
        if !set {
            log::warn!("W_NATIVE_INACTIVE_SCHEDULING_UNAVAILABLE");
        }
    });
    if result.is_err() {
        log::warn!("W_NATIVE_WEBVIEW_UNAVAILABLE");
    }
}

/// # Safety
/// `web_view` must point to a live `WKWebView`.
unsafe fn set_never_suspended(web_view: *mut AnyObject) -> bool {
    if web_view.is_null() {
        return false;
    }
    // SAFETY: `web_view` is a live WKWebView (caller contract), which responds to `configuration`,
    // which responds to `preferences`.
    let preferences: *mut AnyObject = unsafe {
        let configuration: *mut AnyObject = msg_send![web_view, configuration];
        if configuration.is_null() {
            return false;
        }
        msg_send![configuration, preferences]
    };
    if preferences.is_null() {
        return false;
    }
    // SAFETY: `preferences` is a live WKPreferences, and every NSObject answers this.
    if !unsafe { responds(preferences, sel!(setInactiveSchedulingPolicy:)) } {
        return false;
    }
    // SAFETY: the selector exists (checked above) and takes an NSInteger.
    let () =
        unsafe { msg_send![preferences, setInactiveSchedulingPolicy: INACTIVE_SCHEDULING_NONE] };
    true
}

/// Per web view: plugins run in every main window.
pub fn turn_off_resource_hints(window: &tauri::WebviewWindow) {
    let result = window.with_webview(move |webview| {
        let off = guarded("W_NATIVE_WEB_FEATURE_FAILED", || {
            // SAFETY: `inner()` is the live WKWebView owned by this window;
            // every selector is checked with respondsToSelector: before use.
            unsafe { set_web_view_hints_off(webview.inner().cast()) }.then_some(())
        })
        .is_some();
        if off {
            log::info!("I_NATIVE_RESOURCE_HINTS_OFF");
        } else {
            log::warn!("W_NATIVE_RESOURCE_HINTS_UNAVAILABLE");
        }
    });
    if result.is_err() {
        log::warn!("W_NATIVE_WEBVIEW_UNAVAILABLE");
    }
}

/// # Safety
/// `web_view` must point to a live `WKWebView`.
unsafe fn set_web_view_hints_off(web_view: *mut AnyObject) -> bool {
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
    unsafe { turn_off_hints(preferences) }
}

/// Turns off every resource hint WebKit offers plus DNS prefetching (a preference, not a feature).
/// Returns whether preconnect, the only hint that connects synchronously, was turned off.
///
/// # Safety
/// `preferences` must be null or a live `WKPreferences`.
unsafe fn turn_off_hints(preferences: *mut AnyObject) -> bool {
    // SAFETY: `preferences` is null or live (caller contract); each call checks
    // the object and its selector first.
    unsafe { dns_prefetching_off(preferences) };
    let mut preconnect_off = false;
    for key in RESOURCE_HINT_FEATURES {
        // SAFETY: as above.
        let off = unsafe { set_feature(preferences, key, false) };
        if *key == PRECONNECT_FEATURE {
            preconnect_off = off;
        }
    }
    preconnect_off
}

/// `<link rel=dns-prefetch>` resolves a name the instant the link is inserted, outside any policy;
/// this SPI stops it. Returns false when WebKit does not offer it.
///
/// # Safety
/// `preferences` must be null or a live `WKPreferences`.
unsafe fn dns_prefetching_off(preferences: *mut AnyObject) -> bool {
    if preferences.is_null()
        // SAFETY: `preferences` is a non-null WKPreferences (caller contract).
        || !unsafe { responds(preferences, sel!(_setDNSPrefetchingEnabled:)) }
    {
        return false;
    }
    // SAFETY: the selector exists (checked above).
    let _: () = unsafe { msg_send![preferences, _setDNSPrefetchingEnabled: Bool::new(false)] };
    true
}

fn set_main_window_feature(
    window: &tauri::WebviewWindow,
    key: &'static str,
    enabled: bool,
    done: &'static str,
    unavailable: &'static str,
) {
    let result = window.with_webview(move |webview| {
        let set = guarded("W_NATIVE_WEB_FEATURE_FAILED", || {
            // SAFETY: `inner()` is the live WKWebView owned by this window;
            // every selector is checked with respondsToSelector: before use.
            unsafe { set_web_view_feature(webview.inner().cast(), key, enabled) }.then_some(())
        })
        .is_some();
        if set {
            log::info!("{done}");
        } else {
            log::warn!("{unavailable}");
        }
    });
    if result.is_err() {
        log::warn!("W_NATIVE_WEBVIEW_UNAVAILABLE");
    }
}

/// # Safety
/// `web_view` must point to a live `WKWebView`.
unsafe fn set_web_view_feature(web_view: *mut AnyObject, key: &str, enabled: bool) -> bool {
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
    unsafe { set_feature(preferences, key, enabled) }
}

fn web_feature(key: &str) -> Option<*mut AnyObject> {
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
        find_feature(features, key)
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
unsafe fn set_feature(preferences: *mut AnyObject, key: &str, enabled: bool) -> bool {
    if preferences.is_null()
        // SAFETY: `preferences` is a non-null WKPreferences (caller contract).
        || !unsafe { responds(preferences, sel!(_setEnabled:forFeature:)) }
    {
        return false;
    }
    let Some(feature) = web_feature(key) else {
        return false;
    };
    // SAFETY: the selector exists (checked above) and `feature` is a
    // _WKFeature returned by WebKit.
    let _: () =
        unsafe { msg_send![preferences, _setEnabled: Bool::new(enabled), forFeature: feature] };
    true
}

/// # Safety
/// `preferences` must be a live `WKPreferences`.
unsafe fn feature_enabled(preferences: *mut AnyObject, key: &str) -> Option<bool> {
    let feature = web_feature(key)?;
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
    self_test_feature_toggle(SIXTY_FPS_FEATURE)
}

/// Main thread only, as `self_test_sixty_fps_toggle`.
#[doc(hidden)]
pub fn self_test_peer_connection_toggle() -> Result<(), &'static str> {
    self_test_feature_toggle(PEER_CONNECTION_FEATURE)
}

/// Main thread only, as `self_test_sixty_fps_toggle`.
#[doc(hidden)]
pub fn self_test_resource_hints_off() -> Result<(), &'static str> {
    if objc2::MainThreadMarker::new().is_none() {
        return Err("E_NATIVE_NOT_MAIN_THREAD");
    }
    web_feature(PRECONNECT_FEATURE).ok_or("E_NATIVE_FEATURE_MISSING")?;
    let class = AnyClass::get(c"WKPreferences").ok_or("E_NATIVE_WEBKIT_MISSING")?;
    // SAFETY: `+new` returns an owned, live WKPreferences, released below;
    // the private calls run guarded, as the app runs them.
    unsafe {
        let preferences: *mut AnyObject = msg_send![class, new];
        let result = guarded("W_NATIVE_SELF_TEST_FAILED", || {
            Some(if !turn_off_hints(preferences) {
                Err("E_NATIVE_PRECONNECT_NOT_OFF")
            } else if feature_enabled(preferences, PRECONNECT_FEATURE) != Some(false) {
                Err("E_NATIVE_PRECONNECT_STILL_ON")
            } else if !dns_prefetching_off(preferences) {
                Err("E_NATIVE_DNS_PREFETCH_MISSING")
            } else {
                Ok(())
            })
        })
        .unwrap_or(Err("E_NATIVE_HINTS_THREW"));
        let _: () = msg_send![preferences, release];
        result
    }
}

fn self_test_feature_toggle(key: &str) -> Result<(), &'static str> {
    if objc2::MainThreadMarker::new().is_none() {
        return Err("E_NATIVE_NOT_MAIN_THREAD");
    }
    // Regression: `_features` is a class method; checking it as an instance
    // method silently left every window at 60 fps.
    web_feature(key).ok_or("E_NATIVE_FEATURE_MISSING")?;
    let class = AnyClass::get(c"WKPreferences").ok_or("E_NATIVE_WEBKIT_MISSING")?;
    // SAFETY: `+new` returns an owned, live WKPreferences, released below;
    // the private calls run guarded, as the app runs them.
    unsafe {
        let preferences: *mut AnyObject = msg_send![class, new];
        let result = guarded("W_NATIVE_SELF_TEST_FAILED", || {
            Some(if !set_feature(preferences, key, false) {
                Err("E_NATIVE_SET_OFF_FAILED")
            } else if feature_enabled(preferences, key) != Some(false) {
                Err("E_NATIVE_STILL_ON")
            } else if !set_feature(preferences, key, true) {
                Err("E_NATIVE_SET_ON_FAILED")
            } else if feature_enabled(preferences, key) != Some(true) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::macos::self_test_format_menu_keys;

    // Tests that touch WebKit run on the main thread in
    // tests/main_thread.rs; libtest's worker threads crash WebKit.

    #[test]
    fn refuses_a_null_preferences_object() {
        // SAFETY: null is explicitly allowed by the contract.
        assert!(!unsafe { set_feature(std::ptr::null_mut(), SIXTY_FPS_FEATURE, false) });
    }

    #[test]
    fn self_test_refuses_worker_threads() {
        assert_eq!(
            self_test_sixty_fps_toggle(),
            Err("E_NATIVE_NOT_MAIN_THREAD")
        );
        assert_eq!(
            self_test_peer_connection_toggle(),
            Err("E_NATIVE_NOT_MAIN_THREAD")
        );
        assert_eq!(
            self_test_resource_hints_off(),
            Err("E_NATIVE_NOT_MAIN_THREAD")
        );
        assert_eq!(
            self_test_format_menu_keys(),
            Err("E_NATIVE_NOT_MAIN_THREAD")
        );
    }
}
