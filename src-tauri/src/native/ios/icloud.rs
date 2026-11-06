//! CloudKit's remote notifications.

use crate::native::guarded;

static ICLOUD_NOTICE: std::sync::OnceLock<Box<dyn Fn() + Send + Sync>> = std::sync::OnceLock::new();

/// Registers for remote notifications, which CloudKit's zone subscriptions send, and calls
/// `on_notice` on each. Tauri's app delegate has no such method, so one is added to its class.
/// Main thread only.
pub(crate) fn receive_icloud_notices(on_notice: Box<dyn Fn() + Send + Sync>) {
    use objc2::MainThreadMarker;
    use objc2::runtime::{AnyObject, NSObjectProtocol};
    use objc2_ui_kit::UIApplication;
    let Some(mtm) = MainThreadMarker::new() else {
        log::warn!("W_SYNC_ICLOUD_PUSH_OFF_MAIN");
        return;
    };
    if ICLOUD_NOTICE.set(on_notice).is_err() {
        return;
    }
    let done = guarded("W_SYNC_ICLOUD_PUSH_REGISTER", || {
        let app = UIApplication::sharedApplication(mtm);
        // SAFETY: the app delegate is Tauri's, which lives as long as the application; the
        // returned reference is retained for the rest of this closure.
        let delegate = unsafe { app.delegate() }?;
        let selector =
            objc2::sel!(application:didReceiveRemoteNotification:fetchCompletionHandler:);
        if delegate.respondsToSelector(selector) {
            log::warn!("W_SYNC_ICLOUD_PUSH_HANDLED_ELSEWHERE");
        } else {
            let object: &AnyObject = delegate.as_ref();
            let class = object.class();
            let types = c"v@:@@@?";
            // SAFETY: `icloud_notice` takes the receiver, the selector, the application, the
            // notice's dictionary and the completion block and returns nothing, as the encoding
            // says; the delegate does not answer the selector, so nothing is replaced.
            let added = unsafe {
                objc2::ffi::class_addMethod(
                    std::ptr::from_ref(class).cast_mut(),
                    selector,
                    std::mem::transmute::<
                        extern "C-unwind" fn(
                            *mut AnyObject,
                            objc2::runtime::Sel,
                            *mut AnyObject,
                            *mut AnyObject,
                            *mut block2::DynBlock<dyn Fn(usize)>,
                        ),
                        objc2::runtime::Imp,
                    >(icloud_notice),
                    types.as_ptr(),
                )
            };
            if !added.as_bool() {
                log::warn!("W_SYNC_ICLOUD_PUSH_METHOD");
            }
        }
        app.registerForRemoteNotifications();
        Some(())
    });
    if done.is_none() {
        log::warn!("W_SYNC_ICLOUD_PUSH_UNREGISTERED");
    }
}

/// UIKit's `UIBackgroundFetchResultNewData`: the engine pulls on the notice.
const FETCH_NEW_DATA: usize = 0;

extern "C-unwind" fn icloud_notice(
    _delegate: *mut objc2::runtime::AnyObject,
    _selector: objc2::runtime::Sel,
    _application: *mut objc2::runtime::AnyObject,
    _notice: *mut objc2::runtime::AnyObject,
    done: *mut block2::DynBlock<dyn Fn(usize)>,
) {
    use std::panic::{AssertUnwindSafe, catch_unwind};
    if let Some(on_notice) = ICLOUD_NOTICE.get()
        && catch_unwind(AssertUnwindSafe(on_notice)).is_err()
    {
        log::warn!("W_SYNC_ICLOUD_PUSH_PANIC");
    }
    // SAFETY: UIKit passes the completion block it requires be called once, or nil.
    if let Some(done) = unsafe { done.as_ref() } {
        done.call((FETCH_NEW_DATA,));
    }
}
