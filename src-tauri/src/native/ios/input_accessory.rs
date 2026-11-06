//! The bar iOS shows above the keyboard for a web page's fields (previous, next and a check mark),
//! hidden: the phone's own bars hold Hide Keyboard, and its fields need no previous and next.
//! WebKit has no public switch for it (none in the iOS 27 SDK), so the web view's content view gets
//! a subclass of its class whose `inputAccessoryView` is nil. Each step is checked before it is
//! taken, and a WebKit that is not as expected keeps its bar.

use std::ffi::CString;

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::sel;
use objc2_foundation::NSArray;

use crate::native::input_accessory::{Plan, content_view, hidden_name, plan};

extern "C-unwind" fn no_input_accessory_view(_view: &AnyObject, _cmd: Sel) -> *mut AnyObject {
    std::ptr::null_mut()
}

/// The phone's main window: its web view's fields show no bar above the keyboard.
#[cfg(target_os = "ios")]
pub fn hide_input_accessory_bar(window: &tauri::WebviewWindow) {
    let result = window.with_webview(|webview| {
        let hidden = crate::native::guarded("W_NATIVE_INPUT_ACCESSORY_FAILED", || {
            // SAFETY: `inner()` is the live WKWebView owned by this window, and `with_webview`
            // runs this on the main thread.
            unsafe { hide_in_web_view(webview.inner().cast()) }.then_some(())
        })
        .is_some();
        if hidden {
            log::info!("I_NATIVE_INPUT_ACCESSORY_HIDDEN");
        } else {
            log::warn!("W_NATIVE_INPUT_ACCESSORY_UNAVAILABLE");
        }
    });
    if result.is_err() {
        log::warn!("W_NATIVE_WEBVIEW_UNAVAILABLE");
    }
}

/// # Safety
/// `object` must be a live Objective-C object.
unsafe fn responds(object: &AnyObject, selector: Sel) -> bool {
    // SAFETY: `object` is live (caller contract), and every NSObject answers respondsToSelector:.
    let answer: Bool = unsafe { msg_send![object, respondsToSelector: selector] };
    answer.as_bool()
}

/// `false` when the bar stays: no web view, no scroll view or subviews, or no content view WebKit's
/// way.
///
/// # Safety
/// `web_view` must be null or point to a live `WKWebView`; main thread.
unsafe fn hide_in_web_view(web_view: *mut AnyObject) -> bool {
    // SAFETY: null or a live WKWebView (caller contract).
    let Some(web_view) = (unsafe { web_view.as_ref() }) else {
        return false;
    };
    // SAFETY: `web_view` is live; each getter is public WKWebView and UIView API, checked with
    // respondsToSelector: first, returning an object or nil.
    let subviews = unsafe {
        if !responds(web_view, sel!(scrollView)) {
            return false;
        }
        let scroll_view: Option<Retained<AnyObject>> = msg_send![web_view, scrollView];
        let Some(scroll_view) = scroll_view else {
            return false;
        };
        if !responds(&scroll_view, sel!(subviews)) {
            return false;
        }
        let subviews: Option<Retained<NSArray<AnyObject>>> = msg_send![&scroll_view, subviews];
        subviews
    };
    let Some(subviews) = subviews else {
        return false;
    };
    let views = subviews.to_vec();
    let names: Vec<String> = views
        .iter()
        .map(|view| view.class().name().to_string_lossy().into_owned())
        .collect();
    let Some(index) = content_view(&names) else {
        return false;
    };
    // SAFETY: a live subview of the web view's scroll view, on the main thread (caller contract).
    unsafe { hide(&views[index]) }
}

/// `true` once the view has no input accessory view of WebKit's.
///
/// # Safety
/// `view` must be a live object that no other thread uses.
unsafe fn hide(view: &AnyObject) -> bool {
    let class = view.class();
    let Ok(name) = class.name().to_str() else {
        return false;
    };
    // SAFETY: `view` is live (caller contract).
    let answers = unsafe { responds(view, sel!(inputAccessoryView)) };
    match plan(name, answers) {
        Plan::AlreadyHidden => true,
        Plan::LeaveAlone => false,
        Plan::Swap => {
            let Some(subclass) = subclass_without_accessory(class) else {
                return false;
            };
            // SAFETY: the subclass derives from the view's own class, adds no instance variables
            // (so the size is the same) and overrides one getter; no other thread uses the view
            // (caller contract).
            unsafe { AnyObject::set_class(view, subclass) };
            true
        }
    }
}

/// Made once per class; a class of that name that is not a direct subclass of `class` is refused.
fn subclass_without_accessory(class: &'static AnyClass) -> Option<&'static AnyClass> {
    // A class being built cannot be looked up yet, and a second of its name cannot be built.
    static BUILDING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _building = crate::locks::lock(&BUILDING);
    let name = CString::new(hidden_name(class.name().to_str().ok()?)).ok()?;
    if let Some(existing) = AnyClass::get(&name) {
        return (existing.superclass() == Some(class)
            && existing.instance_size() == class.instance_size())
        .then_some(existing);
    }
    let mut builder = ClassBuilder::new(&name, class)?;
    // SAFETY: the method takes no arguments and returns an object or nil, as UIResponder's
    // `inputAccessoryView` does.
    unsafe {
        builder.add_method(
            sel!(inputAccessoryView),
            no_input_accessory_view as extern "C-unwind" fn(_, _) -> _,
        );
    }
    Some(builder.register())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::ffi::CStr;

    use objc2::ClassType;
    use objc2::runtime::NSObject;

    use super::*;

    thread_local! {
        static SUBVIEWS: RefCell<Vec<Retained<AnyObject>>> = const { RefCell::new(Vec::new()) };
    }

    extern "C-unwind" fn itself(this: &AnyObject, _cmd: Sel) -> *mut AnyObject {
        std::ptr::from_ref(this).cast_mut()
    }

    type Getter = extern "C-unwind" fn(&'static AnyObject, Sel) -> *mut AnyObject;

    /// Registered by whichever test thread comes first.
    fn stand_in(name: &CStr, getters: &[(Sel, Getter)]) -> &'static AnyClass {
        static BUILDING: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _building = crate::locks::lock(&BUILDING);
        if let Some(class) = AnyClass::get(name) {
            return class;
        }
        let mut builder =
            ClassBuilder::new(name, NSObject::class()).expect("a stand-in class of a free name");
        for &(selector, getter) in getters {
            // SAFETY: each takes no arguments and returns an object, as the getter it stands in for.
            unsafe { builder.add_method(selector, getter) };
        }
        builder.register()
    }

    extern "C-unwind" fn test_subviews(_this: &AnyObject, _cmd: Sel) -> *mut AnyObject {
        let array = SUBVIEWS.with(|views| NSArray::from_retained_slice(&views.borrow()));
        Retained::autorelease_return(array).cast()
    }

    /// macOS's WebKit has no `WKContentView`, so the tests register one that answers
    /// `inputAccessoryView` with itself.
    fn content_view_class() -> &'static AnyClass {
        stand_in(c"WKContentView", &[(sel!(inputAccessoryView), itself)])
    }

    /// A web view whose scroll view is itself, with the thread's `SUBVIEWS` as its subviews.
    fn web_view_class() -> &'static AnyClass {
        stand_in(
            c"DevotTestInputAccessoryWebView",
            &[(sel!(scrollView), itself), (sel!(subviews), test_subviews)],
        )
    }

    fn make(class: &AnyClass) -> Retained<AnyObject> {
        // SAFETY: an NSObject subclass without instance variables, made with `new`.
        unsafe { msg_send![class, new] }
    }

    fn accessory(view: &AnyObject) -> Option<Retained<AnyObject>> {
        // SAFETY: the view answers the getter (its class or the swapped subclass defines it).
        unsafe { msg_send![view, inputAccessoryView] }
    }

    #[test]
    fn the_content_view_loses_its_accessory_view_once() {
        let view = make(content_view_class());
        assert!(accessory(&view).is_some());
        // SAFETY: a live object of this thread.
        assert!(unsafe { hide(&view) });
        assert_eq!(
            view.class().name().to_str(),
            Ok("WKContentView_DevotNoInputAccessory")
        );
        assert_eq!(view.class().superclass(), Some(content_view_class()));
        assert!(accessory(&view).is_none());
        let swapped = view.class();
        // SAFETY: as above.
        assert!(unsafe { hide(&view) });
        assert!(std::ptr::eq(view.class(), swapped));

        let another = make(content_view_class());
        // SAFETY: as above.
        assert!(unsafe { hide(&another) });
        assert!(std::ptr::eq(another.class(), swapped));
    }

    #[test]
    fn any_other_object_is_left_as_it_is() {
        let object = make(NSObject::class());
        // SAFETY: a live object of this thread.
        assert!(!unsafe { hide(&object) });
        assert!(std::ptr::eq(object.class(), NSObject::class()));
    }

    #[test]
    fn the_web_views_content_view_is_found_and_swapped() {
        let other = make(NSObject::class());
        let content = make(content_view_class());
        SUBVIEWS.with(|views| *views.borrow_mut() = vec![other.clone(), content.clone()]);
        let web_view = make(web_view_class());
        // SAFETY: a live stand-in web view of this thread.
        assert!(unsafe { hide_in_web_view(Retained::as_ptr(&web_view).cast_mut()) });
        assert!(accessory(&content).is_none());
        assert!(std::ptr::eq(other.class(), NSObject::class()));
    }

    #[test]
    fn a_web_view_without_a_content_view_keeps_its_bar() {
        SUBVIEWS.with(|views| *views.borrow_mut() = vec![make(NSObject::class())]);
        let web_view = make(web_view_class());
        let plain = make(NSObject::class());
        // SAFETY: null, a live stand-in web view and a live plain object, all of this thread.
        unsafe {
            assert!(!hide_in_web_view(std::ptr::null_mut()));
            assert!(!hide_in_web_view(Retained::as_ptr(&web_view).cast_mut()));
            assert!(!hide_in_web_view(Retained::as_ptr(&plain).cast_mut()));
        }
    }
}
