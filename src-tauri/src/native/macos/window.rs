//! The main window's corner and the Glass sidebar's active appearance.

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::sel;
use objc2::{ClassType, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSBackingStoreType, NSWindow, NSWindowStyleMask};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

use super::responds;
use crate::native::guarded;

/// The Glass sidebar's corner plus its inset (`radius.window` in the design tokens).
const WINDOW_CORNER_RADIUS: f64 = 26.0;

/// macOS 26 gives a window with no native toolbar a 16 pt corner, tighter than the 18 pt sidebar
/// inset 8 pt inside it, so the two curves cross. A window with a toolbar gets the larger corner the
/// Glass sidebar and toolbar controls are concentric with; this asks for that corner directly. An
/// empty NSToolbar does not change it and moves the traffic lights. Without the private setter the
/// window keeps the system's corner.
pub fn round_window_corner(window: &tauri::WebviewWindow) {
    let target = window.clone();
    let result = window.run_on_main_thread(move || {
        let Some(ns_window) = target.ns_window().ok().filter(|w| !w.is_null()) else {
            log::warn!("W_NATIVE_WINDOW_CORNER_NO_WINDOW");
            return;
        };
        let set = guarded("W_NATIVE_WINDOW_CORNER_FAILED", || {
            // SAFETY: `ns_window()` is the window's live NSWindow, and this runs on the main
            // thread; the private setter is checked with respondsToSelector: before use.
            unsafe { set_window_corner(ns_window.cast(), WINDOW_CORNER_RADIUS) }.then_some(())
        })
        .is_some();
        if !set {
            log::warn!("W_NATIVE_WINDOW_CORNER_UNAVAILABLE");
        }
    });
    if result.is_err() {
        log::warn!("W_NATIVE_WINDOW_CORNER_UNAVAILABLE");
    }
}

/// # Safety
/// `window` must be null or a live NSWindow; main thread.
unsafe fn set_window_corner(window: *mut AnyObject, radius: f64) -> bool {
    // SAFETY: `window` is null or a live NSWindow (caller contract).
    if window.is_null() || !unsafe { responds(window, sel!(_setCornerRadius:)) } {
        return false;
    }
    // SAFETY: `_setCornerRadius:` takes a CGFloat and is checked above. The window server keeps the
    // old corner until the frame is redrawn: setting the style mask to itself and invalidating the
    // shadow (both public NSWindow API) redraws it.
    unsafe {
        let _: () = msg_send![window, _setCornerRadius: radius];
        let mask: usize = msg_send![window, styleMask];
        let _: () = msg_send![window, setStyleMask: mask];
        let _: () = msg_send![window, invalidateShadow];
    }
    true
}

/// Marks a window that keeps the active appearance: an associated object, gone with the window.
static ACTIVE_APPEARANCE_KEY: u8 = 0;
/// The window class given `active_appearance`, and the class above it, which answers for every
/// window that is not marked. Addresses of classes, which are never freed.
static ACTIVE_APPEARANCE_CLASS: std::sync::OnceLock<(usize, usize)> = std::sync::OnceLock::new();

/// The system's glass (NSGlassEffectView, macOS 26) takes its look from the window's
/// `_hasActiveAppearanceIgnoringKeyFocus`: once another app is frontmost it turns flat and grey,
/// unlike the window's material, which stays active (`windowEffects` in `tauri.conf.json`). A main
/// window answers yes throughout, so the sidebar's glass looks the same whether it is key or not.
pub fn keep_glass_active(window: &tauri::WebviewWindow) {
    let target = window.clone();
    let result = window.run_on_main_thread(move || {
        let Some(ns_window) = target.ns_window().ok().filter(|w| !w.is_null()) else {
            log::warn!("W_NATIVE_GLASS_ACTIVE_NO_WINDOW");
            return;
        };
        let kept = guarded("W_NATIVE_GLASS_ACTIVE_FAILED", || {
            // SAFETY: `ns_window()` is the window's live NSWindow, and this runs on the main
            // thread.
            Some(unsafe { keep_active_appearance(ns_window.cast()) })
        });
        if let Some(Err(code)) = kept {
            log::warn!("W_NATIVE_GLASS_ACTIVE_UNAVAILABLE {code}");
        }
    });
    if result.is_err() {
        log::warn!("W_NATIVE_GLASS_ACTIVE_UNAVAILABLE E_NATIVE_MAIN_THREAD_UNAVAILABLE");
    }
}

/// Whether `window` now keeps the active appearance: `Ok(false)` where the system has no glass,
/// so nothing needs it.
///
/// # Safety
/// `window` must be null or a live NSWindow; main thread.
unsafe fn keep_active_appearance(window: *mut AnyObject) -> Result<bool, &'static str> {
    if window.is_null() {
        return Err("E_NATIVE_GLASS_ACTIVE_NO_WINDOW");
    }
    if AnyClass::get(c"NSGlassEffectView").is_none() {
        return Ok(false);
    }
    // SAFETY: `window` is a live NSWindow (caller contract).
    if !unsafe { responds(window, sel!(_hasActiveAppearanceIgnoringKeyFocus)) } {
        return Err("E_NATIVE_GLASS_ACTIVE_SELECTOR_MISSING");
    }
    // SAFETY: every NSObject answers `class`. Under key-value observing it answers the window's
    // own class, which the observing class derives from, so the method added there is found.
    let class: *const AnyClass = unsafe { msg_send![window, class] };
    // SAFETY: a class pointer from the runtime, null or registered for the life of the process.
    let class = unsafe { class.as_ref() }.ok_or("E_NATIVE_GLASS_ACTIVE_NO_CLASS")?;
    answer_active_appearance(class)?;
    // SAFETY: `window` is live; the key is a static's address. The value only has to be non-nil:
    // a class, which lives for the whole process, so it is assigned without being retained.
    unsafe {
        objc2::ffi::objc_setAssociatedObject(
            window,
            std::ptr::from_ref(&ACTIVE_APPEARANCE_KEY).cast(),
            std::ptr::from_ref(class).cast_mut().cast(),
            objc2::ffi::OBJC_ASSOCIATION_ASSIGN,
        );
    }
    Ok(true)
}

/// Gives `class` its own `_hasActiveAppearanceIgnoringKeyFocus`, once: yes for a marked window,
/// and the class above's answer for any other. Only one class is ever given it.
fn answer_active_appearance(class: &'static AnyClass) -> Result<(), &'static str> {
    let address = std::ptr::from_ref(class) as usize;
    if let Some(&(given, _)) = ACTIVE_APPEARANCE_CLASS.get() {
        return if given == address {
            Ok(())
        } else {
            Err("E_NATIVE_GLASS_ACTIVE_OTHER_CLASS")
        };
    }
    let selector = sel!(_hasActiveAppearanceIgnoringKeyFocus);
    let types = std::ffi::CString::new(format!("{}@:", <Bool as objc2::encode::Encode>::ENCODING))
        .map_err(|_| "E_NATIVE_GLASS_ACTIVE_ENCODING")?;
    let superclass = class
        .superclass()
        .filter(|superclass| superclass.instance_method(selector).is_some())
        .ok_or("E_NATIVE_GLASS_ACTIVE_SELECTOR_MISSING")?;
    // SAFETY: `active_appearance` takes the receiver and the selector and returns a BOOL, as the
    // encoding says. `class_addMethod` refuses a class that defines the selector itself, so no
    // method of the window's own class is replaced.
    let added = unsafe {
        objc2::ffi::class_addMethod(
            std::ptr::from_ref(class).cast_mut(),
            selector,
            std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, objc2::runtime::Sel) -> Bool,
                objc2::runtime::Imp,
            >(active_appearance),
            types.as_ptr(),
        )
    };
    if !added.as_bool() {
        return Err("E_NATIVE_GLASS_ACTIVE_ALREADY_DEFINED");
    }
    let _ = ACTIVE_APPEARANCE_CLASS.set((address, std::ptr::from_ref(superclass) as usize));
    Ok(())
}

extern "C-unwind" fn active_appearance(
    window: *mut AnyObject,
    selector: objc2::runtime::Sel,
) -> Bool {
    // SAFETY: the receiver is a live window; the key is a static's address.
    let marked = unsafe {
        objc2::ffi::objc_getAssociatedObject(
            window,
            std::ptr::from_ref(&ACTIVE_APPEARANCE_KEY).cast(),
        )
    };
    if !marked.is_null() {
        return Bool::YES;
    }
    let Some(&(_, superclass)) = ACTIVE_APPEARANCE_CLASS.get() else {
        return Bool::NO;
    };
    // SAFETY: the address of a registered class, which is never freed.
    let superclass = unsafe { &*(superclass as *const AnyClass) };
    let Some(method) = superclass.instance_method(selector) else {
        return Bool::NO;
    };
    // SAFETY: NSWindow's `_hasActiveAppearanceIgnoringKeyFocus` takes no arguments and returns a
    // BOOL; it was there when this method was added.
    let original = unsafe {
        std::mem::transmute::<
            objc2::runtime::Imp,
            extern "C-unwind" fn(*mut AnyObject, objc2::runtime::Sel) -> Bool,
        >(method.implementation())
    };
    original(window, selector)
}

/// A window of the app's own window class, observed with key-value observing as the real one is:
/// once marked it keeps the active appearance while it is not key, and a second call changes
/// nothing. Other windows of the class keep their own answers, yes or no, and an object that is no window is
/// refused. `Ok(false)` where the system has no glass.
#[doc(hidden)]
pub fn self_test_glass_stays_active() -> Result<bool, &'static str> {
    use objc2::rc::Allocated;
    use objc2::runtime::{ClassBuilder, NSObject};
    let mtm = MainThreadMarker::new().ok_or("E_NATIVE_NOT_MAIN_THREAD")?;
    let _app = NSApplication::sharedApplication(mtm);
    /// The class above the app's window class answers yes for a window at half opacity, so an
    /// unmarked window is seen to keep a yes as well as a no.
    extern "C-unwind" fn half_opaque_is_active(
        window: &AnyObject,
        _cmd: objc2::runtime::Sel,
    ) -> Bool {
        // SAFETY: the receiver is a live NSWindow; `alphaValue` is public NSWindow API.
        let alpha: f64 = unsafe { msg_send![window, alphaValue] };
        Bool::new(alpha == HALF)
    }
    const HALF: f64 = 0.5;
    let base = match AnyClass::get(c"DevotGlassTestBase") {
        Some(class) => class,
        None => {
            let mut builder = ClassBuilder::new(c"DevotGlassTestBase", NSWindow::class())
                .ok_or("E_GLASS_ACTIVE_TEST_CLASS")?;
            // SAFETY: the method takes no arguments and returns a BOOL, as NSWindow's does.
            unsafe {
                builder.add_method(
                    sel!(_hasActiveAppearanceIgnoringKeyFocus),
                    half_opaque_is_active as extern "C-unwind" fn(_, _) -> _,
                );
            }
            builder.register()
        }
    };
    let class = match AnyClass::get(c"DevotGlassTestWindow") {
        Some(class) => class,
        None => ClassBuilder::new(c"DevotGlassTestWindow", base)
            .ok_or("E_GLASS_ACTIVE_TEST_CLASS")?
            .register(),
    };
    let rect = NSRect::new(
        NSPoint::new(-20_000.0, -20_000.0),
        NSSize::new(400.0, 300.0),
    );
    let make = || -> Result<Retained<NSWindow>, &'static str> {
        // SAFETY: a subclass of NSWindow without instance variables, made as an NSWindow is: alloc, then
        // the designated initializer with a valid frame, style, backing and defer flag.
        unsafe {
            let allocated: Allocated<AnyObject> = msg_send![class, alloc];
            let made: Option<Retained<AnyObject>> = msg_send![
                allocated,
                initWithContentRect: rect,
                styleMask: NSWindowStyleMask::Titled,
                backing: NSBackingStoreType::Buffered,
                defer: false
            ];
            let window =
                Retained::cast_unchecked::<NSWindow>(made.ok_or("E_GLASS_ACTIVE_NO_WINDOW")?);
            window.setReleasedWhenClosed(false);
            Ok(window)
        }
    };
    let window = make()?;
    let other = make()?;
    let half_opaque = make()?;
    half_opaque.setAlphaValue(HALF);
    let pointer =
        |window: &Retained<NSWindow>| Retained::as_ptr(window).cast_mut().cast::<AnyObject>();
    let active = |window: &Retained<NSWindow>| -> Result<bool, &'static str> {
        let pointer = pointer(window);
        // SAFETY: a live window; the selector is checked first.
        unsafe {
            if !responds(pointer, sel!(_hasActiveAppearanceIgnoringKeyFocus)) {
                return Err("E_NATIVE_GLASS_ACTIVE_SELECTOR_MISSING");
            }
            let answer: Bool = msg_send![pointer, _hasActiveAppearanceIgnoringKeyFocus];
            Ok(answer.as_bool())
        }
    };
    let observer = NSObject::new();
    let key_path = NSString::from_str("title");
    // SAFETY: public KVO API on a live window; the observer is removed below, before either goes,
    // and the title is never changed, so the observer is never called.
    unsafe {
        let _: () = msg_send![
            &*window,
            addObserver: &*observer,
            forKeyPath: &*key_path,
            options: 0usize,
            context: std::ptr::null_mut::<std::ffi::c_void>()
        ];
    }
    let result = (|| {
        if AnyClass::get(c"NSGlassEffectView").is_none() {
            // SAFETY: a live window; main thread.
            return match unsafe { keep_active_appearance(pointer(&window)) } {
                Ok(false) => Ok(false),
                _ => Err("E_GLASS_ACTIVE_CHANGED_A_WINDOW_WITHOUT_GLASS"),
            };
        }
        let plain = NSObject::new();
        // SAFETY: a live object that answers no window selector; main thread.
        if unsafe { keep_active_appearance(Retained::as_ptr(&plain).cast_mut().cast()) }.is_ok() {
            return Err("E_GLASS_ACTIVE_ACCEPTED_A_NON_WINDOW");
        }
        // SAFETY: a live window.
        if std::ptr::eq(unsafe { &*pointer(&window) }.class(), class) {
            return Err("E_GLASS_ACTIVE_TEST_NOT_OBSERVED");
        }
        if active(&window)? || active(&other)? || window.isKeyWindow() {
            return Err("E_GLASS_ACTIVE_WINDOW_ACTIVE_BEFORE");
        }
        if !active(&half_opaque)? {
            return Err("E_GLASS_ACTIVE_TEST_BASE_INACTIVE");
        }
        for _ in 0..2 {
            // SAFETY: a live window; main thread.
            if unsafe { keep_active_appearance(pointer(&window)) } != Ok(true) {
                return Err("E_GLASS_ACTIVE_NOT_KEPT");
            }
            if !active(&window)? {
                return Err("E_GLASS_ACTIVE_WINDOW_INACTIVE_AFTER");
            }
        }
        if active(&other)? || !active(&half_opaque)? {
            return Err("E_GLASS_ACTIVE_OTHER_WINDOW_CHANGED");
        }
        Ok(true)
    })();
    // SAFETY: the observer added above, on the same window and key path.
    unsafe {
        let _: () = msg_send![&*window, removeObserver: &*observer, forKeyPath: &*key_path];
    }
    window.close();
    other.close();
    half_opaque.close();
    result
}
