//! The iCloud container entitlement and CloudKit's remote notifications.

use std::panic::{AssertUnwindSafe, catch_unwind};

use objc2::runtime::AnyObject;
use objc2::sel;
use objc2_foundation::NSObjectProtocol;

use crate::native::guarded;

#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SecTaskCreateFromSelf(
        allocator: core_foundation::base::CFAllocatorRef,
    ) -> *mut std::ffi::c_void;
    fn SecTaskCopyValueForEntitlement(
        task: *mut std::ffi::c_void,
        entitlement: core_foundation::string::CFStringRef,
        error: *mut core_foundation::error::CFErrorRef,
    ) -> core_foundation::base::CFTypeRef;
}

/// Whether this app is signed with Devot's iCloud container: release builds with the profile are,
/// `.dev`, CI and unsigned builds are not, and must never touch `CKContainer`.
pub(crate) fn holds_icloud_container() -> bool {
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::string::CFString;
    let entitlement =
        CFString::from_static_string("com.apple.developer.icloud-container-identifiers");
    // SAFETY: a null allocator is the default one; the task is created under the create rule and
    // released by its wrapper.
    let task = unsafe { SecTaskCreateFromSelf(std::ptr::null()) };
    if task.is_null() {
        return false;
    }
    // SAFETY: as above; a non-null task is a CF object this code owns.
    let task = unsafe { CFType::wrap_under_create_rule(task.cast_const()) };
    // SAFETY: the task and the name are live CF objects; a null error pointer asks for none; the
    // value comes under the create rule.
    let value = unsafe {
        SecTaskCopyValueForEntitlement(
            task.as_CFTypeRef().cast_mut(),
            entitlement.as_concrete_TypeRef(),
            std::ptr::null_mut(),
        )
    };
    if value.is_null() {
        return false;
    }
    // SAFETY: as above, a non-null value this code owns.
    let value = unsafe { CFType::wrap_under_create_rule(value) };
    let Some(containers) = value.downcast::<CFArray>() else {
        return false;
    };
    containers.iter().any(|item| {
        // SAFETY: an item of a live array, retained by the get rule for its wrapper.
        let item = unsafe { CFType::wrap_under_get_rule(*item) };
        item.downcast::<CFString>()
            .is_some_and(|name| name == CFString::new(crate::sync::cloudkit::kit::CONTAINER))
    })
}

static ICLOUD_NOTICE: std::sync::OnceLock<Box<dyn Fn() + Send + Sync>> = std::sync::OnceLock::new();

/// Registers for remote notifications, which CloudKit's zone subscriptions send, and calls
/// `on_notice` on each. Tauri's app delegate has no such method, so one is added to its class.
/// Main thread only.
pub(crate) fn receive_icloud_notices(on_notice: Box<dyn Fn() + Send + Sync>) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    let Some(mtm) = MainThreadMarker::new() else {
        log::warn!("W_SYNC_ICLOUD_PUSH_OFF_MAIN");
        return;
    };
    if ICLOUD_NOTICE.set(on_notice).is_err() {
        return;
    }
    let done = guarded("W_SYNC_ICLOUD_PUSH_REGISTER", || {
        let app = NSApplication::sharedApplication(mtm);
        let delegate = app.delegate()?;
        let selector = sel!(application:didReceiveRemoteNotification:);
        if delegate.respondsToSelector(selector) {
            log::warn!("W_SYNC_ICLOUD_PUSH_HANDLED_ELSEWHERE");
        } else {
            let object: &AnyObject = delegate.as_ref();
            let class = object.class();
            let types = c"v@:@@";
            // SAFETY: `icloud_notice` takes the receiver, the selector, the application and the
            // notice's dictionary and returns nothing, as the encoding says; the delegate does not
            // answer the selector, so nothing is replaced.
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

extern "C-unwind" fn icloud_notice(
    _delegate: *mut AnyObject,
    _selector: objc2::runtime::Sel,
    _application: *mut AnyObject,
    _notice: *mut AnyObject,
) {
    if let Some(on_notice) = ICLOUD_NOTICE.get()
        && catch_unwind(AssertUnwindSafe(on_notice)).is_err()
    {
        log::warn!("W_SYNC_ICLOUD_PUSH_PANIC");
    }
}
