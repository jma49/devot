//! iOS's native code: UIKit calls through objc2, one keychain call and the StoreKit bridge; and
//! CloudKit (`cloudkit`), which macOS compiles from here too, so that it is written once. Every
//! call runs inside `guarded`, which catches an Objective-C exception as well as a Rust panic, and
//! every object the system may withhold is checked for nil; a failure gives the caller's fallback.
//! The exception is building zone and record IDs, from names the transport has already checked.

#[cfg(target_os = "ios")]
use block2::RcBlock;
#[cfg(target_os = "ios")]
use objc2::AllocAnyThread;
#[cfg(target_os = "ios")]
use objc2_core_foundation::{CGPoint, CGSize};
#[cfg(target_os = "ios")]
use objc2_foundation::NSString;
#[cfg(target_os = "ios")]
use objc2_ui_kit::{
    UIColor, UIGraphicsImageRenderer, UIGraphicsImageRendererFormat,
    UIGraphicsImageRendererFormatRange, UIImage, UIImageRenderingMode, UIImageSymbolConfiguration,
    UIImageSymbolWeight, UITraitCollection,
};

#[cfg(target_os = "ios")]
use super::HapticKind;
use super::guarded;

/// On the main thread only (`native::haptic` sends it there); off it, nothing plays.
#[cfg(target_os = "ios")]
pub fn haptic(kind: HapticKind) {
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_ui_kit::{
        UIImpactFeedbackGenerator, UIImpactFeedbackStyle, UINotificationFeedbackGenerator,
        UINotificationFeedbackType, UISelectionFeedbackGenerator,
    };
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let _ = guarded("W_NATIVE_HAPTIC_FAILED", || {
        match kind {
            HapticKind::Light | HapticKind::Soft => {
                let style = if kind == HapticKind::Light {
                    UIImpactFeedbackStyle::Light
                } else {
                    UIImpactFeedbackStyle::Soft
                };
                // Its replacement, `feedbackGeneratorWithStyle_forView`, needs the web view, which this
                // command does not hold; the deprecated initializer still plays on every supported iOS.
                #[allow(deprecated)]
                let generator = UIImpactFeedbackGenerator::initWithStyle(
                    UIImpactFeedbackGenerator::alloc(mtm),
                    style,
                );
                generator.impactOccurred();
            }
            HapticKind::Selection => UISelectionFeedbackGenerator::new(mtm).selectionChanged(),
            HapticKind::Success => UINotificationFeedbackGenerator::new(mtm)
                .notificationOccurred(UINotificationFeedbackType::Success),
            HapticKind::Warning => UINotificationFeedbackGenerator::new(mtm)
                .notificationOccurred(UINotificationFeedbackType::Warning),
        }
        Some(())
    });
}

/// Hands an https URL to Safari (`external::open_external` has checked it). Main thread only;
/// `false` when it was not handed over.
#[cfg(target_os = "ios")]
pub fn open_url(url: &str) -> bool {
    use objc2::MainThreadMarker;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSDictionary, NSURL};
    use objc2_ui_kit::UIApplication;
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    guarded("W_NATIVE_OPEN_URL_FAILED", || {
        let url = NSURL::URLWithString(&NSString::from_str(url))?;
        let options = NSDictionary::<NSString, AnyObject>::new();
        // SAFETY: the options are the empty dictionary of option keys to objects the method takes,
        // and no completion handler is given.
        unsafe {
            UIApplication::sharedApplication(mtm)
                .openURL_options_completionHandler(&url, &options, None);
        }
        Some(())
    })
    .is_some()
}

/// Gives every window of every connected scene the interface style (`native::interface_style`), so
/// UIKit's chrome and the web view's `prefers-color-scheme` follow it. Main thread only.
#[cfg(target_os = "ios")]
pub fn set_interface_style(style: isize) {
    use objc2::MainThreadMarker;
    use objc2_ui_kit::{UIApplication, UIUserInterfaceStyle, UIWindowScene};
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let _ = guarded("W_NATIVE_APPEARANCE_FAILED", || {
        for scene in UIApplication::sharedApplication(mtm)
            .connectedScenes()
            .iter()
        {
            let Some(scene) = scene.downcast_ref::<UIWindowScene>() else {
                continue;
            };
            for window in scene.windows().iter() {
                window.setOverrideUserInterfaceStyle(UIUserInterfaceStyle(style));
            }
        }
        Some(())
    });
}

/// The key window's top-most view controller that is not on its way out; with no key window, the
/// first window's.
#[cfg(target_os = "ios")]
fn top_view_controller(
    mtm: objc2::MainThreadMarker,
) -> Option<objc2::rc::Retained<objc2_ui_kit::UIViewController>> {
    use objc2_ui_kit::{UIApplication, UIWindowScene};
    let mut windows = Vec::new();
    for scene in UIApplication::sharedApplication(mtm)
        .connectedScenes()
        .iter()
    {
        if let Some(scene) = scene.downcast_ref::<UIWindowScene>() {
            windows.extend(scene.windows().iter());
        }
    }
    let window = windows
        .iter()
        .find(|window| window.isKeyWindow())
        .or(windows.first())?;
    let mut top = window.rootViewController()?;
    while let Some(next) = top.presentedViewController() {
        if next.isBeingDismissed() {
            break;
        }
        top = next;
    }
    Some(top)
}

/// Presents the system share sheet for a message and a link (`share::phone_share` has checked
/// both) over the top-most view controller: on an iPhone it rises from the bottom, and a popover
/// (an iPad's) points at the bottom middle of that controller's view. `done` hears whether an
/// activity completed at the handler's first call (a cancel inside another app's share extension
/// dismisses the whole sheet and answers once); when nothing was presented it is dropped uncalled.
/// Main thread only.
#[cfg(target_os = "ios")]
pub fn share(text: &str, url: &str, done: impl FnOnce(bool) + 'static) {
    use std::cell::Cell;

    use objc2::runtime::{AnyObject, Bool};
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_core_foundation::CGRect;
    use objc2_foundation::{NSArray, NSError, NSURL};
    use objc2_ui_kit::UIActivityViewController;
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let _ = guarded("W_NATIVE_SHARE_FAILED", move || {
        let presenter = top_view_controller(mtm)?;
        let view = presenter.view()?;
        let text = NSString::from_str(text);
        let url = NSURL::URLWithString(&NSString::from_str(url))?;
        let text_item: &AnyObject = &text;
        let url_item: &AnyObject = &url;
        let items = NSArray::from_slice(&[text_item, url_item]);
        // SAFETY: the items are a string and a URL, both of which the share sheet takes, and there
        // are no activities of the app's own.
        let sheet = unsafe {
            UIActivityViewController::initWithActivityItems_applicationActivities(
                UIActivityViewController::alloc(mtm),
                &items,
                None,
            )
        };
        let done = Cell::new(Some(done));
        let finished = RcBlock::new(
            move |_activity: *mut NSString,
                  completed: Bool,
                  _items: *mut NSArray,
                  _error: *mut NSError| {
                if let Some(done) = done.take() {
                    done(completed.as_bool());
                }
            },
        );
        // SAFETY: `finished` is a live block of the handler's type, which the controller copies;
        // UIKit calls it on the main thread, and it reads none of the pointers it is given.
        unsafe { sheet.setCompletionWithItemsHandler(RcBlock::as_ptr(&finished)) };
        if let Some(popover) = sheet.popoverPresentationController() {
            let bounds = view.bounds();
            popover.setSourceView(Some(&view));
            popover.setSourceRect(CGRect::new(
                CGPoint::new(bounds.size.width / 2.0, bounds.size.height),
                CGSize::ZERO,
            ));
        }
        presenter.presentViewController_animated_completion(&sheet, true, None);
        Some(())
    });
}

/// One call at a time (`native::render_one_at_a_time`) on a blocking thread, where UIKit's images
/// and image renderers may be used. The symbol is laid out for a display scale of 1, on whole points
/// as AppKit lays it out (for the screen's scale UIKit sizes it in thirds of a point, and it sits
/// higher in its PNG than on the Mac). UIKit's temporaries go in an autorelease pool of the call's
/// own, as the thread has none to empty.
#[cfg(target_os = "ios")]
pub fn symbol_png(name: &str, point_size: f64, weight: &str) -> Option<Vec<u8>> {
    objc2::rc::autoreleasepool(|_| {
        guarded("W_NATIVE_SYMBOL_FAILED", || {
            let one_pixel_a_point = UITraitCollection::traitCollectionWithDisplayScale(1.0);
            let configuration = UIImageSymbolConfiguration::configurationWithPointSize_weight(
                point_size * super::SYMBOL_PIXELS_PER_POINT,
                UIImageSymbolWeight(super::symbol_weight_rank(weight)),
            )
            .configurationWithTraitCollection(Some(&one_pixel_a_point));
            let image = UIImage::systemImageNamed_withConfiguration(
                &NSString::from_str(name),
                Some(&configuration),
            )?;
            // SAFETY: a property read of an image `systemImageNamed` just made for this call; no other thread holds it.
            let size = unsafe { image.size() };
            let (width, height) = super::symbol_canvas(size.width, size.height)?;
            let format =
                UIGraphicsImageRendererFormat::formatForTraitCollection(&one_pixel_a_point);
            format.setScale(1.0);
            format.setOpaque(false);
            // Eight bits a channel in sRGB, as AppKit's PNG has, also on a wide-colour screen.
            format.setPreferredRange(UIGraphicsImageRendererFormatRange::Standard);
            let renderer = UIGraphicsImageRenderer::initWithSize_format(
                UIGraphicsImageRenderer::alloc(),
                CGSize::new(width, height),
                &format,
            );
            let black = image.imageWithTintColor_renderingMode(
                &UIColor::blackColor(),
                UIImageRenderingMode::AlwaysOriginal,
            );
            let draw = RcBlock::new(move |_| black.drawAtPoint(CGPoint::ZERO));
            // SAFETY: `draw` is a live block that UIKit runs before the call returns; it only draws
            // an image this thread owns into the renderer's context.
            let png = unsafe { renderer.PNGDataWithActions(RcBlock::as_ptr(&draw)) };
            Some(png.to_vec())
        })
    })
}

/// Adds a generic password item that opens after the first unlock and stays on the device (never
/// in iCloud or a backup). `SecItemAdd` refuses an item that exists, so nothing is ever replaced;
/// a failure gives its `OSStatus`. The password API cannot add without updating, hence this call.
#[cfg(target_os = "ios")]
pub fn add_device_only_password(service: &str, account: &str, secret: &[u8]) -> Result<(), i32> {
    use core_foundation::base::TCFType;
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework_sys::item::{
        kSecAttrAccessControl, kSecAttrAccount, kSecAttrService, kSecClass,
        kSecClassGenericPassword, kSecValueData,
    };
    use security_framework_sys::keychain_item::SecItemAdd;

    let access = SecAccessControl::create_with_protection(
        Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
        0,
    )
    .map_err(|error| error.code())?;
    // SAFETY: the Security framework's attribute names are CFString constants that live as long as
    // the process; the get rule retains each one for its wrapper.
    let [
        class,
        generic_password,
        service_name,
        account_name,
        access_control,
        data,
    ] = unsafe {
        [
            kSecClass,
            kSecClassGenericPassword,
            kSecAttrService,
            kSecAttrAccount,
            kSecAttrAccessControl,
            kSecValueData,
        ]
        .map(|name| CFString::wrap_under_get_rule(name))
    };
    let attributes = CFDictionary::from_CFType_pairs(&[
        (class, generic_password.into_CFType()),
        (service_name, CFString::new(service).into_CFType()),
        (account_name, CFString::new(account).into_CFType()),
        (access_control, access.into_CFType()),
        (data, CFData::from_buffer(secret).into_CFType()),
    ]);
    // SAFETY: `attributes` is a valid dictionary that outlives the call, and a null result pointer
    // asks for nothing back.
    let status = unsafe { SecItemAdd(attributes.as_concrete_TypeRef(), std::ptr::null_mut()) };
    if status == 0 { Ok(()) } else { Err(status) }
}

#[cfg(target_os = "ios")]
pub use store::*;

#[cfg(target_os = "ios")]
mod store {
    use std::collections::BTreeMap;
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, MutexGuard, OnceLock};

    use tokio::sync::oneshot;

    /// The StoreKit bridge (`src-tauri/apple/DevotStore`, `Bridge.swift`). Each call starts a Swift
    /// task and returns; the task replies once, on a thread of its own, with the call's request number
    /// and UTF-8 JSON that stays valid only until the callback returns, so Rust copies it and Swift
    /// frees it. Numbers, not pointers, name the waiting call: a late or repeated reply finds none and
    /// is dropped.
    type StoreReply = extern "C" fn(request: u64, json: *const u8, len: usize);
    type StoreUpdate = extern "C" fn(json: *const u8, len: usize);

    // SAFETY: these are the `@_cdecl` functions of `Bridge.swift`, with the same C types; the iOS app
    // links the Swift package that defines them.
    unsafe extern "C" {
        fn devot_store_products(request: u64, reply: StoreReply);
        fn devot_store_purchase(
            request: u64,
            product_id: *const u8,
            product_id_len: usize,
            reply: StoreReply,
        );
        fn devot_store_restore(request: u64, reply: StoreReply);
        fn devot_store_entitlements(request: u64, reply: StoreReply);
        fn devot_store_finish(request: u64, transaction_id: u64, reply: StoreReply);
        fn devot_store_listen(update: StoreUpdate) -> bool;
    }

    /// Far above two products' transactions with their JWS; a reply beyond it is read as empty.
    const STORE_REPLY_LIMIT: usize = 4 << 20;

    type StoreCalls = BTreeMap<u64, oneshot::Sender<Vec<u8>>>;

    static STORE_CALLS: Mutex<StoreCalls> = Mutex::new(BTreeMap::new());
    static STORE_NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);
    static STORE_UPDATES: OnceLock<Box<dyn Fn(Vec<u8>) + Send + Sync>> = OnceLock::new();

    fn store_calls() -> MutexGuard<'static, StoreCalls> {
        crate::locks::lock(&STORE_CALLS)
    }

    fn copy_store_reply(json: *const u8, len: usize) -> Vec<u8> {
        if json.is_null() || len == 0 || len > STORE_REPLY_LIMIT {
            return Vec::new();
        }
        // SAFETY: Swift passes `len` initialised bytes that stay valid and unchanged until the callback
        // that received them returns, and this copy happens inside it.
        unsafe { std::slice::from_raw_parts(json, len) }.to_vec()
    }

    extern "C" fn store_reply(request: u64, json: *const u8, len: usize) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let json = copy_store_reply(json, len);
            if let Some(waiting) = store_calls().remove(&request) {
                let _ = waiting.send(json);
            }
        }));
    }

    extern "C" fn store_update(json: *const u8, len: usize) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let json = copy_store_reply(json, len);
            if let Some(deliver) = STORE_UPDATES.get() {
                deliver(json);
            }
        }));
    }

    fn store_call(start: impl FnOnce(u64)) -> oneshot::Receiver<Vec<u8>> {
        let request = STORE_NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        store_calls().insert(request, sender);
        start(request);
        receiver
    }

    pub fn store_products() -> oneshot::Receiver<Vec<u8>> {
        // SAFETY: the bridge function only starts a task and returns; `store_reply` is a plain function
        // that lives as long as the process.
        store_call(|request| unsafe { devot_store_products(request, store_reply) })
    }

    pub fn store_purchase(product_id: &str) -> oneshot::Receiver<Vec<u8>> {
        // SAFETY: `product_id` is `product_id.len()` bytes of UTF-8 that outlive the call, which copies
        // them before it returns; `store_reply` lives as long as the process.
        store_call(|request| unsafe {
            devot_store_purchase(request, product_id.as_ptr(), product_id.len(), store_reply)
        })
    }

    pub fn store_restore() -> oneshot::Receiver<Vec<u8>> {
        // SAFETY: as in `store_products`.
        store_call(|request| unsafe { devot_store_restore(request, store_reply) })
    }

    pub fn store_entitlements() -> oneshot::Receiver<Vec<u8>> {
        // SAFETY: as in `store_products`.
        store_call(|request| unsafe { devot_store_entitlements(request, store_reply) })
    }

    pub fn store_finish(transaction_id: u64) -> oneshot::Receiver<Vec<u8>> {
        // SAFETY: as in `store_products`; the transaction ID is a plain number.
        store_call(|request| unsafe { devot_store_finish(request, transaction_id, store_reply) })
    }

    /// Starts StoreKit's transaction listener, which hands every update's JSON to `deliver` on a Swift
    /// thread. Only the first call starts it; a later one gives `false`.
    pub fn store_listen(deliver: Box<dyn Fn(Vec<u8>) + Send + Sync>) -> bool {
        if STORE_UPDATES.set(deliver).is_err() {
            return false;
        }
        // SAFETY: the bridge function only starts the listener task and returns; `store_update` lives
        // as long as the process, and `STORE_UPDATES` is set before any update can arrive.
        unsafe { devot_store_listen(store_update) }
    }
}

#[cfg(target_os = "ios")]
static ICLOUD_NOTICE: std::sync::OnceLock<Box<dyn Fn() + Send + Sync>> = std::sync::OnceLock::new();

/// Registers for remote notifications, which CloudKit's zone subscriptions send, and calls
/// `on_notice` on each. Tauri's app delegate has no such method, so one is added to its class.
/// Main thread only.
#[cfg(target_os = "ios")]
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
#[cfg(target_os = "ios")]
const FETCH_NEW_DATA: usize = 0;

#[cfg(target_os = "ios")]
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

#[cfg(all(test, target_os = "ios"))]
mod tests {
    use super::*;
    use crate::native::{SYMBOL_WEIGHTS, symbol_weight_rank};

    #[test]
    fn weight_ranks_are_uikits_weights() {
        let uikit = [
            UIImageSymbolWeight::UltraLight,
            UIImageSymbolWeight::Thin,
            UIImageSymbolWeight::Light,
            UIImageSymbolWeight::Regular,
            UIImageSymbolWeight::Medium,
            UIImageSymbolWeight::Semibold,
            UIImageSymbolWeight::Bold,
            UIImageSymbolWeight::Heavy,
            UIImageSymbolWeight::Black,
        ];
        for (name, weight) in SYMBOL_WEIGHTS.iter().zip(uikit) {
            assert_eq!(
                UIImageSymbolWeight(symbol_weight_rank(name)),
                weight,
                "{name}"
            );
        }
    }
}

/// CloudKit through objc2 (`sync::cloudkit::kit`), the same on macOS and iOS, so macOS compiles it
/// from here as well; each platform says whether the build holds the container (`macos::cloudkit`,
/// `cloudkit::from_info_plist`). Every call runs inside `guarded`, and every operation's answer is
/// awaited off the main thread with a time limit, after which the operation is cancelled.
pub(crate) mod cloudkit {
    use std::path::Path;
    use std::ptr::NonNull;
    use std::sync::mpsc::{Sender, channel};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, ProtocolObject};
    use objc2::{AllocAnyThread, ClassType};
    use objc2_cloud_kit::{
        CKAccountStatus, CKAsset, CKContainer, CKDatabaseOperation, CKErrorDomain,
        CKErrorRetryAfterKey, CKFetchRecordZoneChangesConfiguration,
        CKFetchRecordZoneChangesOperation, CKFetchRecordZonesOperation, CKFetchRecordsOperation,
        CKModifyRecordZonesOperation, CKModifyRecordsOperation, CKModifySubscriptionsOperation,
        CKNotificationInfo, CKRecord, CKRecordChangedErrorServerRecordKey, CKRecordID,
        CKRecordSavePolicy, CKRecordValue, CKRecordZone, CKRecordZoneID, CKRecordZoneSubscription,
        CKServerChangeToken, CKSubscription,
    };
    use objc2_foundation::{
        NSArray, NSCoding, NSData, NSDictionary, NSError, NSKeyedArchiver, NSKeyedUnarchiver,
        NSNumber, NSQualityOfService, NSString, NSURL,
    };

    use super::guarded;
    use crate::locks::lock;
    use crate::sync::cloudkit::error::code;
    use crate::sync::cloudkit::kit::{
        Account, CONTAINER, Changes, CkError, CkRecord, CloudKit, SavePolicy, Value,
    };

    const WAIT: Duration = Duration::from_secs(120);
    /// Uploads and downloads of assets take longer than a small request.
    const WAIT_TRANSFER: Duration = Duration::from_secs(600);

    pub(crate) struct Native {
        available: bool,
    }

    impl Native {
        /// `available` is the platform's answer to whether this build holds the container; without
        /// it, nothing here touches `CKContainer`.
        pub(crate) fn new(available: bool) -> Self {
            Self { available }
        }
    }

    /// iOS keeps no entitlement the app can read, so a build that may use CloudKit names its
    /// container in Info.plist (`DevotCloudKitContainer`, written only on iCloud builds).
    #[cfg(target_os = "ios")]
    pub(crate) fn from_info_plist() -> bool {
        guarded("W_SYNC_ICLOUD_INFO_PLIST", || {
            let bundle = objc2_foundation::NSBundle::mainBundle();
            let value =
                bundle.objectForInfoDictionaryKey(&NSString::from_str("DevotCloudKitContainer"))?;
            let name = value.downcast_ref::<NSString>()?;
            Some(name.to_string() == CONTAINER)
        })
        .unwrap_or(false)
    }

    fn container() -> Retained<CKContainer> {
        // SAFETY: a container identifier is any string; CloudKit makes or finds the container.
        unsafe { CKContainer::containerWithIdentifier(&NSString::from_str(CONTAINER)) }
    }

    fn native_error() -> CkError {
        CkError::of(code::NATIVE)
    }

    /// Starts an operation inside `guarded` and waits for the one answer its blocks send.
    fn run<T: 'static>(
        what: &'static str,
        wait: Duration,
        start: impl FnOnce(Sender<Result<T, CkError>>) -> Option<Retained<CKDatabaseOperation>>,
    ) -> Result<T, CkError> {
        let (sender, answer) = channel();
        let operation = guarded(what, || start(sender)).ok_or_else(native_error)?;
        match answer.recv_timeout(wait) {
            Ok(result) => result,
            Err(_) => {
                log::warn!("{what} E_SYNC_ICLOUD_TIMEOUT");
                let _ = guarded(what, || {
                    operation.cancel();
                    Some(())
                });
                Err(CkError::of(code::NETWORK_FAILURE))
            }
        }
    }

    fn add(operation: &CKDatabaseOperation) {
        operation.setQualityOfService(NSQualityOfService::UserInitiated);
        // SAFETY: the private database of the app's own container takes any database operation.
        unsafe { container().privateCloudDatabase().addOperation(operation) };
    }

    fn zone_id(zone: &str) -> Retained<CKRecordZoneID> {
        // SAFETY: a zone in the private database is named by the app and owned by the user, whom
        // `CKCurrentUserDefaultName` names.
        unsafe {
            CKRecordZoneID::initWithZoneName_ownerName(
                CKRecordZoneID::alloc(),
                &NSString::from_str(zone),
                objc2_cloud_kit::CKCurrentUserDefaultName,
            )
        }
    }

    fn record_id(name: &str, zone: &CKRecordZoneID) -> Retained<CKRecordID> {
        // SAFETY: record names are checked by the transport (letters, digits and '-').
        unsafe {
            CKRecordID::initWithRecordName_zoneID(
                CKRecordID::alloc(),
                &NSString::from_str(name),
                zone,
            )
        }
    }

    /// `None` stays `None`; an error from CloudKit becomes its code, its wait and, for
    /// `serverRecordChanged`, the server's record.
    fn error_of(error: *mut NSError) -> Option<CkError> {
        // SAFETY: CloudKit passes a valid error or nil, retained for the block's call.
        let error = unsafe { error.as_ref() }?;
        // SAFETY: the CloudKit error keys are constant strings that live as long as the process.
        let (domain, retry_key, server_key) = unsafe {
            (
                CKErrorDomain,
                CKErrorRetryAfterKey,
                CKRecordChangedErrorServerRecordKey,
            )
        };
        if error.domain().to_string() != domain.to_string() {
            let network = error.domain().to_string() == "NSURLErrorDomain";
            return Some(CkError::of(if network {
                code::NETWORK_FAILURE
            } else {
                code::INTERNAL_ERROR
            }));
        }
        let info = error.userInfo();
        let retry_after_ms = info
            .objectForKey(retry_key)
            .and_then(|value| value.downcast_ref::<NSNumber>().map(|n| n.doubleValue()))
            .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
            .map(|seconds| (seconds * 1000.0) as u64);
        let server_record = info
            .objectForKey(server_key)
            .and_then(|value| value.downcast_ref::<CKRecord>().map(|r| from_ck(r, false)))
            .flatten()
            .map(Box::new);
        Some(CkError {
            code: error.code() as i64,
            retry_after_ms,
            server_record,
        })
    }

    fn archive_system_fields(record: &CKRecord) -> Vec<u8> {
        let archiver = NSKeyedArchiver::initRequiringSecureCoding(NSKeyedArchiver::alloc(), true);
        // SAFETY: a keyed archiver is the coder `encodeSystemFieldsWithCoder:` documents.
        unsafe { record.encodeSystemFieldsWithCoder(&archiver) };
        archiver.finishEncoding();
        archiver.encodedData().to_vec()
    }

    fn unarchive_record(system: &[u8]) -> Option<Retained<CKRecord>> {
        let data = NSData::with_bytes(system);
        // SAFETY: the data is read with secure coding, which refuses any class but CKRecord's own.
        let unarchiver = unsafe {
            NSKeyedUnarchiver::initForReadingFromData_error(NSKeyedUnarchiver::alloc(), &data)
        }
        .ok()?;
        // SAFETY: as above; `initWithCoder:` is CKRecord's NSSecureCoding initializer, and the
        // unarchiver is finished once it has read the record.
        unsafe {
            unarchiver.setRequiresSecureCoding(true);
            let record = CKRecord::initWithCoder(CKRecord::alloc(), &unarchiver);
            unarchiver.finishDecoding();
            record
        }
    }

    fn archive_token(token: &CKServerChangeToken) -> Option<Vec<u8>> {
        // SAFETY: a change token supports secure coding, which the archive is made with.
        unsafe {
            NSKeyedArchiver::archivedDataWithRootObject_requiringSecureCoding_error(token, true)
        }
        .ok()
        .map(|data| data.to_vec())
    }

    fn unarchive_token(bytes: &[u8]) -> Option<Retained<CKServerChangeToken>> {
        let data = NSData::with_bytes(bytes);
        // SAFETY: secure coding with the one class allowed, so nothing else is made from the data.
        unsafe {
            NSKeyedUnarchiver::unarchivedObjectOfClass_fromData_error(
                CKServerChangeToken::class(),
                &data,
            )
        }
        .ok()?
        .downcast::<CKServerChangeToken>()
        .ok()
    }

    fn set_value(record: &CKRecord, key: &str, value: &Value) -> Option<()> {
        let key = NSString::from_str(key);
        let object: Option<Retained<ProtocolObject<dyn CKRecordValue>>> = match value {
            Value::Int(n) => Some(ProtocolObject::from_retained(NSNumber::new_i64(*n))),
            Value::Text(text) => Some(ProtocolObject::from_retained(NSString::from_str(text))),
            Value::Bytes(bytes) => Some(ProtocolObject::from_retained(NSData::with_bytes(bytes))),
            Value::Asset(path) => {
                let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?));
                // SAFETY: the file is a staged chunk that stays until the operation has ended.
                let asset = unsafe { CKAsset::initWithFileURL(CKAsset::alloc(), &url) };
                Some(ProtocolObject::from_retained(asset))
            }
            Value::Null => None,
        };
        // SAFETY: the values are the CKRecordValue classes CloudKit stores; nil removes the key.
        unsafe { record.setObject_forKey(object.as_deref(), &key) };
        Some(())
    }

    fn value_of(object: &AnyObject, with_assets: bool) -> Option<Value> {
        if let Some(number) = object.downcast_ref::<NSNumber>() {
            return Some(Value::Int(number.longLongValue()));
        }
        if let Some(text) = object.downcast_ref::<NSString>() {
            return Some(Value::Text(text.to_string()));
        }
        if let Some(data) = object.downcast_ref::<NSData>() {
            return Some(Value::Bytes(data.to_vec()));
        }
        if let Some(asset) = object.downcast_ref::<CKAsset>() {
            if !with_assets {
                return None;
            }
            // SAFETY: a fetched asset's file URL; its file lasts until the operation ends, and is
            // read here, inside the operation's block.
            let url = unsafe { asset.fileURL() }?;
            let path = url.path()?.to_string();
            return std::fs::read(Path::new(&path)).ok().map(Value::Bytes);
        }
        None
    }

    /// `None` when a call threw or returned nothing; `BAD_TAG` when the tag is not this record's
    /// archive.
    fn to_ck(
        zone: &CKRecordZoneID,
        record: &CkRecord,
    ) -> Option<Result<Retained<CKRecord>, CkError>> {
        let ck = match &record.system {
            Some(system) => {
                let Some(ck) = unarchive_record(system) else {
                    return Some(Err(CkError::of(code::BAD_TAG)));
                };
                // SAFETY: plain accessors of a record made just now.
                let (name, zone_name) = unsafe {
                    let id = ck.recordID();
                    (
                        id.recordName().to_string(),
                        id.zoneID().zoneName().to_string(),
                    )
                };
                // SAFETY: as above.
                let zone_wanted = unsafe { zone.zoneName() }.to_string();
                if name != record.name || zone_name != zone_wanted {
                    return Some(Err(CkError::of(code::BAD_TAG)));
                }
                ck
            }
            // SAFETY: a record type is any name the app uses; the ID is in the app's own zone.
            None => unsafe {
                CKRecord::initWithRecordType_recordID(
                    CKRecord::alloc(),
                    &NSString::from_str(&record.kind),
                    &record_id(&record.name, zone),
                )
            },
        };
        for (key, value) in &record.fields {
            set_value(&ck, key, value)?;
        }
        Some(Ok(ck))
    }

    fn from_ck(record: &CKRecord, with_assets: bool) -> Option<CkRecord> {
        // SAFETY: plain accessors of a record CloudKit handed over for this call.
        let (name, kind, keys, modified) = unsafe {
            (
                record.recordID().recordName().to_string(),
                record.recordType().to_string(),
                record.allKeys(),
                record.modificationDate(),
            )
        };
        let mut out = CkRecord::new(&kind, &name);
        out.system = Some(archive_system_fields(record));
        out.modified = modified.map(|date| (date.timeIntervalSince1970() * 1000.0) as i64);
        for key in keys.iter() {
            // SAFETY: a key the record just listed.
            let Some(object) = (unsafe { record.objectForKey(&key) }) else {
                continue;
            };
            let any: &AnyObject = object.as_ref();
            if let Some(value) = value_of(any, with_assets) {
                out.set(&key.to_string(), value);
            }
        }
        Some(out)
    }

    fn converted(record: *mut CKRecord, with_assets: bool) -> Option<CkRecord> {
        // SAFETY: CloudKit passes a valid record or nil, retained for the block's call.
        let record = unsafe { record.as_ref() }?;
        guarded("W_SYNC_ICLOUD_RECORD_READ", || from_ck(record, with_assets))
    }

    impl CloudKit for Native {
        fn available(&self) -> bool {
            self.available
        }

        fn account(&self) -> Result<Account, CkError> {
            if !self.available {
                return Err(CkError::of(code::MISSING_ENTITLEMENT));
            }
            let (sender, answer) = channel();
            guarded("W_SYNC_ICLOUD_ACCOUNT", || {
                let block = RcBlock::new(move |status: CKAccountStatus, error: *mut NSError| {
                    let result = match error_of(error) {
                        Some(error) => Err(error),
                        None => Ok(match status {
                            CKAccountStatus::Available => Account::Available,
                            CKAccountStatus::NoAccount => Account::Missing,
                            CKAccountStatus::Restricted => Account::Restricted,
                            CKAccountStatus::TemporarilyUnavailable => {
                                Account::TemporarilyUnavailable
                            }
                            _ => Account::CouldNotDetermine,
                        }),
                    };
                    let _ = sender.send(result);
                });
                // SAFETY: the block takes the status and an optional error, as CloudKit calls it.
                unsafe { container().accountStatusWithCompletionHandler(&block) };
                Some(())
            })
            .ok_or_else(native_error)?;
            answer
                .recv_timeout(WAIT)
                .unwrap_or(Err(CkError::of(code::NETWORK_FAILURE)))
        }

        fn user_record_name(&self) -> Result<String, CkError> {
            if !self.available {
                return Err(CkError::of(code::MISSING_ENTITLEMENT));
            }
            let (sender, answer) = channel();
            guarded("W_SYNC_ICLOUD_USER", || {
                let block = RcBlock::new(move |id: *mut CKRecordID, error: *mut NSError| {
                    let result = match error_of(error) {
                        Some(error) => Err(error),
                        None => {
                            // SAFETY: CloudKit passes a valid record ID or nil with an error, and
                            // `recordName` is a plain accessor.
                            unsafe { id.as_ref().map(|id| id.recordName().to_string()) }
                                .ok_or_else(native_error)
                        }
                    };
                    let _ = sender.send(result);
                });
                // SAFETY: the block takes an optional record ID and error, as CloudKit calls it.
                unsafe { container().fetchUserRecordIDWithCompletionHandler(&block) };
                Some(())
            })
            .ok_or_else(native_error)?;
            answer
                .recv_timeout(WAIT)
                .unwrap_or(Err(CkError::of(code::NETWORK_FAILURE)))
        }

        fn zones_exist(&self, zones: &[String]) -> Result<Vec<bool>, CkError> {
            if !self.available {
                return Err(CkError::of(code::MISSING_ENTITLEMENT));
            }
            let found = Arc::new(Mutex::new(Vec::<String>::new()));
            let missing = Arc::new(Mutex::new(Option::<CkError>::None));
            let (seen, failed) = (Arc::clone(&found), Arc::clone(&missing));
            let ids: Vec<_> = zones.iter().map(|zone| zone_id(zone)).collect();
            run("W_SYNC_ICLOUD_ZONES", WAIT, move |sender| {
                // SAFETY: the zone IDs are the app's own.
                let operation = unsafe {
                    CKFetchRecordZonesOperation::initWithRecordZoneIDs(
                        CKFetchRecordZonesOperation::alloc(),
                        &NSArray::from_retained_slice(&ids),
                    )
                };
                let per_zone = RcBlock::new(
                    move |id: NonNull<CKRecordZoneID>,
                          zone: *mut CKRecordZone,
                          error: *mut NSError| {
                        // SAFETY: CloudKit passes the zone ID it asked about.
                        let name = unsafe { id.as_ref().zoneName() }.to_string();
                        match error_of(error) {
                            Some(error)
                                if matches!(
                                    error.code,
                                    code::ZONE_NOT_FOUND | code::USER_DELETED_ZONE
                                ) => {}
                            Some(error) => *lock(&failed) = Some(error),
                            None if !zone.is_null() => lock(&seen).push(name),
                            None => {}
                        }
                    },
                );
                let missing = Arc::clone(&missing);
                let done = RcBlock::new(
                    move |_: *mut NSDictionary<CKRecordZoneID, CKRecordZone>,
                          error: *mut NSError| {
                        let whole = error_of(error).filter(|e| e.code != code::PARTIAL_FAILURE);
                        let _ = sender.send(match whole.or_else(|| lock(&missing).take()) {
                            Some(error) => Err(error),
                            None => Ok(()),
                        });
                    },
                );
                // SAFETY: each block's arguments are as CloudKit documents them for this operation.
                unsafe {
                    operation.setPerRecordZoneCompletionBlock(Some(&per_zone));
                    operation.setFetchRecordZonesCompletionBlock(Some(&done));
                }
                add(&operation);
                Some(Retained::into_super(operation))
            })?;
            let found = lock(&found);
            Ok(zones.iter().map(|zone| found.contains(zone)).collect())
        }

        fn save_zones(&self, zones: &[String]) -> Result<(), CkError> {
            if !self.available {
                return Err(CkError::of(code::MISSING_ENTITLEMENT));
            }
            let zones: Vec<_> = zones
                .iter()
                // SAFETY: a zone named by the app in its private database.
                .map(|zone| unsafe {
                    CKRecordZone::initWithZoneName(CKRecordZone::alloc(), &NSString::from_str(zone))
                })
                .collect();
            run("W_SYNC_ICLOUD_ZONES_SAVE", WAIT, move |sender| {
                // SAFETY: zones to save and none to delete.
                let operation = unsafe {
                    CKModifyRecordZonesOperation::initWithRecordZonesToSave_recordZoneIDsToDelete(
                        CKModifyRecordZonesOperation::alloc(),
                        Some(&NSArray::from_retained_slice(&zones)),
                        None,
                    )
                };
                let done = RcBlock::new(
                    move |_: *mut NSArray<CKRecordZone>,
                          _: *mut NSArray<CKRecordZoneID>,
                          error: *mut NSError| {
                        let _ = sender.send(error_of(error).map_or(Ok(()), Err));
                    },
                );
                // SAFETY: the block's arguments are as CloudKit documents them for this operation.
                unsafe { operation.setModifyRecordZonesCompletionBlock(Some(&done)) };
                add(&operation);
                Some(Retained::into_super(operation))
            })
        }

        fn delete_zones(&self, zones: &[String]) -> Result<(), CkError> {
            if !self.available {
                return Err(CkError::of(code::MISSING_ENTITLEMENT));
            }
            let failed = Arc::new(Mutex::new(Option::<CkError>::None));
            let seen = Arc::clone(&failed);
            let ids: Vec<_> = zones.iter().map(|zone| zone_id(zone)).collect();
            run("W_SYNC_ICLOUD_ZONES_DELETE", WAIT, move |sender| {
                // SAFETY: none to save and the app's own zone IDs to delete.
                let operation = unsafe {
                    CKModifyRecordZonesOperation::initWithRecordZonesToSave_recordZoneIDsToDelete(
                        CKModifyRecordZonesOperation::alloc(),
                        None,
                        Some(&NSArray::from_retained_slice(&ids)),
                    )
                };
                let per_zone =
                    RcBlock::new(move |_: NonNull<CKRecordZoneID>, error: *mut NSError| {
                        match error_of(error) {
                            Some(error)
                                if matches!(
                                    error.code,
                                    code::ZONE_NOT_FOUND | code::USER_DELETED_ZONE
                                ) => {}
                            Some(error) => *lock(&seen) = Some(error),
                            None => {}
                        }
                    });
                let done = RcBlock::new(
                    move |_: *mut NSArray<CKRecordZone>,
                          _: *mut NSArray<CKRecordZoneID>,
                          error: *mut NSError| {
                        let whole = error_of(error).filter(|e| e.code != code::PARTIAL_FAILURE);
                        let _ = sender.send(match whole.or_else(|| lock(&failed).take()) {
                            Some(error) => Err(error),
                            None => Ok(()),
                        });
                    },
                );
                // SAFETY: each block's arguments are as CloudKit documents them for this operation.
                unsafe {
                    operation.setPerRecordZoneDeleteBlock(Some(&per_zone));
                    operation.setModifyRecordZonesCompletionBlock(Some(&done));
                }
                add(&operation);
                Some(Retained::into_super(operation))
            })
        }

        fn fetch(&self, zone: &str, names: &[String]) -> Result<Vec<Option<CkRecord>>, CkError> {
            if !self.available {
                return Err(CkError::of(code::MISSING_ENTITLEMENT));
            }
            let zone = zone_id(zone);
            let ids: Vec<_> = names.iter().map(|name| record_id(name, &zone)).collect();
            let got = Arc::new(Mutex::new(Vec::<(String, Result<CkRecord, CkError>)>::new()));
            let into = Arc::clone(&got);
            run("W_SYNC_ICLOUD_FETCH", WAIT_TRANSFER, move |sender| {
                // SAFETY: record IDs in the app's own zone.
                let operation = unsafe {
                    CKFetchRecordsOperation::initWithRecordIDs(
                        CKFetchRecordsOperation::alloc(),
                        &NSArray::from_retained_slice(&ids),
                    )
                };
                let per_record = RcBlock::new(
                    move |record: *mut CKRecord, id: *mut CKRecordID, error: *mut NSError| {
                        // SAFETY: CloudKit passes the record ID it asked about, or nil, and
                        // `recordName` is a plain accessor.
                        let Some(name) =
                            (unsafe { id.as_ref().map(|id| id.recordName().to_string()) })
                        else {
                            return;
                        };
                        let result = match error_of(error) {
                            Some(error) => Err(error),
                            None => converted(record, true).ok_or_else(native_error),
                        };
                        lock(&into).push((name, result));
                    },
                );
                let done = RcBlock::new(
                    move |_: *mut NSDictionary<CKRecordID, CKRecord>, error: *mut NSError| {
                        let whole = error_of(error).filter(|e| e.code != code::PARTIAL_FAILURE);
                        let _ = sender.send(whole.map_or(Ok(()), Err));
                    },
                );
                // SAFETY: each block's arguments are as CloudKit documents them for this operation.
                #[allow(deprecated)]
                unsafe {
                    operation.setPerRecordCompletionBlock(Some(&per_record));
                    operation.setFetchRecordsCompletionBlock(Some(&done));
                }
                add(&operation);
                Some(Retained::into_super(operation))
            })?;
            let mut got = lock(&got);
            names
                .iter()
                .map(|name| {
                    match got
                        .iter()
                        .position(|(n, _)| n == name)
                        .map(|at| got.remove(at).1)
                    {
                        Some(Ok(record)) => Ok(Some(record)),
                        Some(Err(error)) if error.code == code::UNKNOWN_ITEM => Ok(None),
                        Some(Err(error)) => Err(error),
                        None => Ok(None),
                    }
                })
                .collect()
        }

        fn save(
            &self,
            zone: &str,
            records: &[CkRecord],
            policy: SavePolicy,
        ) -> Result<Vec<Result<CkRecord, CkError>>, CkError> {
            if !self.available {
                return Err(CkError::of(code::MISSING_ENTITLEMENT));
            }
            let zone = zone_id(zone);
            let built: Vec<Result<Retained<CKRecord>, CkError>> = records
                .iter()
                .map(|record| {
                    guarded("W_SYNC_ICLOUD_RECORD_BUILD", || to_ck(&zone, record))
                        .unwrap_or_else(|| Err(native_error()))
                })
                .collect();
            let sending: Vec<Retained<CKRecord>> = built
                .iter()
                .filter_map(|b| b.as_ref().ok())
                .cloned()
                .collect();
            let got = Arc::new(Mutex::new(Vec::<(String, Result<CkRecord, CkError>)>::new()));
            if !sending.is_empty() {
                let into = Arc::clone(&got);
                run("W_SYNC_ICLOUD_SAVE", WAIT_TRANSFER, move |sender| {
                    // SAFETY: records to save and none to delete; records are never deleted.
                    let operation = unsafe {
                        CKModifyRecordsOperation::initWithRecordsToSave_recordIDsToDelete(
                            CKModifyRecordsOperation::alloc(),
                            Some(&NSArray::from_retained_slice(&sending)),
                            None,
                        )
                    };
                    let per_record = RcBlock::new(
                        move |id: NonNull<CKRecordID>,
                              record: *mut CKRecord,
                              error: *mut NSError| {
                            // SAFETY: CloudKit passes the ID of a record this operation saved.
                            let name = unsafe { id.as_ref().recordName() }.to_string();
                            let result = match error_of(error) {
                                Some(error) => Err(error),
                                None => converted(record, false).ok_or_else(native_error),
                            };
                            lock(&into).push((name, result));
                        },
                    );
                    let done = RcBlock::new(
                        move |_: *mut NSArray<CKRecord>,
                              _: *mut NSArray<CKRecordID>,
                              error: *mut NSError| {
                            let whole = error_of(error).filter(|e| e.code != code::PARTIAL_FAILURE);
                            let _ = sender.send(whole.map_or(Ok(()), Err));
                        },
                    );
                    // SAFETY: each block's arguments are as CloudKit documents them; the policy
                    // is one of CloudKit's own.
                    unsafe {
                        operation.setSavePolicy(match policy {
                            SavePolicy::IfUnchanged => CKRecordSavePolicy::IfServerRecordUnchanged,
                            SavePolicy::Overwrite => CKRecordSavePolicy::ChangedKeys,
                        });
                        operation.setAtomic(false);
                        operation.setPerRecordSaveBlock(Some(&per_record));
                        operation.setModifyRecordsCompletionBlock(Some(&done));
                    }
                    add(&operation);
                    Some(Retained::into_super(operation))
                })?;
            }
            let mut got = lock(&got);
            Ok(records
                .iter()
                .zip(&built)
                .map(|(record, built)| {
                    if let Err(e) = built {
                        return Err(e.clone());
                    }
                    got.iter()
                        .position(|(n, _)| *n == record.name)
                        .map_or(Err(CkError::of(code::INTERNAL_ERROR)), |at| {
                            got.remove(at).1
                        })
                })
                .collect())
        }

        fn changes(
            &self,
            zone: &str,
            token: Option<&[u8]>,
            limit: usize,
        ) -> Result<Changes, CkError> {
            if !self.available {
                return Err(CkError::of(code::MISSING_ENTITLEMENT));
            }
            let previous = match token {
                Some(bytes) => {
                    Some(unarchive_token(bytes).ok_or(CkError::of(code::CHANGE_TOKEN_EXPIRED))?)
                }
                None => None,
            };
            let zone = zone_id(zone);
            let records = Arc::new(Mutex::new(Vec::<CkRecord>::new()));
            let end = Arc::new(Mutex::new(Option::<Result<(Vec<u8>, bool), CkError>>::None));
            let (into, ended) = (Arc::clone(&records), Arc::clone(&end));
            run("W_SYNC_ICLOUD_CHANGES", WAIT_TRANSFER, move |sender| {
                // SAFETY: a plain configuration object; the token was archived by this code.
                let configuration = unsafe {
                    let configuration = CKFetchRecordZoneChangesConfiguration::new();
                    configuration.setPreviousServerChangeToken(previous.as_deref());
                    configuration.setResultsLimit(limit);
                    configuration
                };
                let configurations = NSDictionary::from_retained_objects(&[&*zone], &[configuration]);
                // SAFETY: one zone of the app's own and its configuration.
                let operation = unsafe {
                    CKFetchRecordZoneChangesOperation::initWithRecordZoneIDs_configurationsByRecordZoneID(
                        CKFetchRecordZoneChangesOperation::alloc(),
                        &NSArray::from_retained_slice(std::slice::from_ref(&zone)),
                        Some(&configurations),
                    )
                };
                let changed = RcBlock::new(
                    move |_: NonNull<CKRecordID>, record: *mut CKRecord, error: *mut NSError| {
                        if error_of(error).is_none()
                            && let Some(record) = converted(record, true)
                        {
                            lock(&into).push(record);
                        }
                    },
                );
                let zone_done = RcBlock::new(
                    move |_: NonNull<CKRecordZoneID>,
                          token: *mut CKServerChangeToken,
                          _: *mut NSData,
                          more: Bool,
                          error: *mut NSError| {
                        let result = match error_of(error) {
                            Some(error) => Err(error),
                            // SAFETY: CloudKit passes a valid token or nil.
                            None => unsafe { token.as_ref() }
                                .and_then(archive_token)
                                .map(|token| (token, more.as_bool()))
                                .ok_or_else(native_error),
                        };
                        *lock(&ended) = Some(result);
                    },
                );
                let end = Arc::clone(&end);
                let done = RcBlock::new(move |error: *mut NSError| {
                    let zone = lock(&end).take();
                    let whole = error_of(error).filter(|e| e.code != code::PARTIAL_FAILURE);
                    let _ = sender.send(match (zone, whole) {
                        (Some(result), _) => result,
                        (None, Some(error)) => Err(error),
                        (None, None) => Err(native_error()),
                    });
                });
                // SAFETY: each block's arguments are as CloudKit documents them for this operation;
                // one page per operation, so the transport pages with its own cursor.
                unsafe {
                    operation.setFetchAllChanges(false);
                    operation.setRecordWasChangedBlock(Some(&changed));
                    operation.setRecordZoneFetchCompletionBlock(Some(&zone_done));
                    operation.setFetchRecordZoneChangesCompletionBlock(Some(&done));
                }
                add(&operation);
                Some(Retained::into_super(operation))
            })
            .map(|(token, more)| Changes {
                records: std::mem::take(&mut *lock(&records)),
                token,
                more,
            })
        }

        fn subscribe(&self, zone: &str, id: &str) -> Result<(), CkError> {
            if !self.available {
                return Err(CkError::of(code::MISSING_ENTITLEMENT));
            }
            let zone = zone_id(zone);
            let id = NSString::from_str(id);
            run("W_SYNC_ICLOUD_SUBSCRIBE", WAIT, move |sender| {
                // SAFETY: a zone subscription with a silent notice, which wakes the app without an
                // alert; the IDs are the app's own.
                let subscription = unsafe {
                    let subscription = CKRecordZoneSubscription::initWithZoneID_subscriptionID(
                        CKRecordZoneSubscription::alloc(),
                        &zone,
                        &id,
                    );
                    let info = CKNotificationInfo::new();
                    info.setShouldSendContentAvailable(true);
                    subscription.setNotificationInfo(Some(&info));
                    subscription
                };
                let subscriptions: [Retained<CKSubscription>; 1] =
                    [Retained::into_super(subscription)];
                // SAFETY: subscriptions to save and none to delete.
                let operation = unsafe {
                    CKModifySubscriptionsOperation::initWithSubscriptionsToSave_subscriptionIDsToDelete(
                        CKModifySubscriptionsOperation::alloc(),
                        Some(&NSArray::from_retained_slice(&subscriptions)),
                        None,
                    )
                };
                let done = RcBlock::new(
                    move |_: *mut NSArray<CKSubscription>,
                          _: *mut NSArray<NSString>,
                          error: *mut NSError| {
                        let _ = sender.send(error_of(error).map_or(Ok(()), Err));
                    },
                );
                // SAFETY: the block's arguments are as CloudKit documents them for this operation.
                unsafe { operation.setModifySubscriptionsCompletionBlock(Some(&done)) };
                add(&operation);
                Some(Retained::into_super(operation))
            })
        }
    }

    /// Calls `on_change` on each `CKAccountChanged`, for the life of the process.
    pub(crate) fn observe_account(on_change: Box<dyn Fn() + Send + Sync>) {
        let _ = guarded("W_SYNC_ICLOUD_ACCOUNT_OBSERVE", || {
            let block = RcBlock::new(move |_: NonNull<objc2_foundation::NSNotification>| {
                use std::panic::{AssertUnwindSafe, catch_unwind};
                if catch_unwind(AssertUnwindSafe(&on_change)).is_err() {
                    log::warn!("W_SYNC_ICLOUD_ACCOUNT_PANIC");
                }
            });
            // SAFETY: the notice's name is CloudKit's constant; with no queue the block runs on the
            // posting thread, and it only calls the service, which is thread-safe.
            let observer = unsafe {
                objc2_foundation::NSNotificationCenter::defaultCenter()
                    .addObserverForName_object_queue_usingBlock(
                        Some(objc2_cloud_kit::CKAccountChangedNotification),
                        None,
                        None,
                        &block,
                    )
            };
            // The observer is kept for the life of the process.
            std::mem::forget(observer);
            Some(())
        });
    }
}

/// Synchronizable generic password items (`sync::keychain::SyncedKeychain`), the same on macOS and
/// iOS, so macOS compiles them from here too: in the data protection keychain and an access group,
/// readable after the first unlock, carried to the owner's other devices by the iCloud Keychain.
/// A failure gives its `OSStatus`.
pub(crate) mod synced_keychain {
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::{CFString, CFStringRef};
    use security_framework_sys::access_control::kSecAttrAccessibleAfterFirstUnlock;
    use security_framework_sys::item::{
        kSecAttrAccessGroup, kSecAttrAccount, kSecAttrService, kSecAttrSynchronizable, kSecClass,
        kSecClassGenericPassword, kSecMatchLimit, kSecReturnData, kSecValueData,
    };
    use security_framework_sys::keychain_item::{
        SecItemAdd, SecItemCopyMatching, SecItemDelete, SecItemUpdate,
    };

    use super::guarded;

    // The crate declares the first only on macOS builds that ask for 10.15, and not the others.
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        static kSecUseDataProtectionKeychain: CFStringRef;
        static kSecAttrAccessible: CFStringRef;
        static kSecMatchLimitOne: CFStringRef;
    }

    use crate::keychain::{DUPLICATE_ITEM as DUPLICATE, ITEM_NOT_FOUND as NOT_FOUND};
    /// `errSecDecode`: the item's data was not data.
    const DECODE: i32 = -26275;
    /// `errSecInternalComponent`: the call itself failed.
    const INTERNAL: i32 = -2070;

    fn constant(name: CFStringRef) -> CFString {
        // SAFETY: every name passed here is one of the Security framework's CFString constants, which
        // live as long as the process; the get rule retains it for its wrapper.
        unsafe { CFString::wrap_under_get_rule(name) }
    }

    /// The attributes that name the item: class, service, account, group, synchronizable, and the
    /// data protection keychain (the only one on iOS, and on macOS the one that syncs).
    fn query(service: &str, account: &str, group: &str) -> Vec<(CFString, CFType)> {
        // SAFETY: reads of the Security framework's constant names, which never change.
        let (class, generic, service_key, account_key, group_key, synchronizable, protected) = unsafe {
            (
                kSecClass,
                kSecClassGenericPassword,
                kSecAttrService,
                kSecAttrAccount,
                kSecAttrAccessGroup,
                kSecAttrSynchronizable,
                kSecUseDataProtectionKeychain,
            )
        };
        vec![
            (constant(class), constant(generic).into_CFType()),
            (constant(service_key), CFString::new(service).into_CFType()),
            (constant(account_key), CFString::new(account).into_CFType()),
            (constant(group_key), CFString::new(group).into_CFType()),
            (
                constant(synchronizable),
                CFBoolean::true_value().into_CFType(),
            ),
            (constant(protected), CFBoolean::true_value().into_CFType()),
        ]
    }

    fn call(work: impl FnOnce() -> i32) -> i32 {
        guarded("W_SYNC_HANDOVER_NATIVE", || Some(work())).unwrap_or(INTERNAL)
    }

    pub(crate) fn read(service: &str, account: &str, group: &str) -> Result<Option<Vec<u8>>, i32> {
        let mut pairs = query(service, account, group);
        // SAFETY: as in `query`.
        let (return_data, limit, one) =
            unsafe { (kSecReturnData, kSecMatchLimit, kSecMatchLimitOne) };
        pairs.push((constant(return_data), CFBoolean::true_value().into_CFType()));
        pairs.push((constant(limit), constant(one).into_CFType()));
        let query = CFDictionary::from_CFType_pairs(&pairs);
        let mut result: CFTypeRef = std::ptr::null();
        let status = call(|| {
            // SAFETY: `query` is a valid dictionary that outlives the call; `result` is written only
            // on success, with an object this code then owns under the create rule.
            unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut result) }
        });
        match status {
            0 if !result.is_null() => {
                // SAFETY: a non-null result of a successful copy, owned by this code.
                let value = unsafe { CFType::wrap_under_create_rule(result) };
                value
                    .downcast::<CFData>()
                    .map(|data| Some(data.bytes().to_vec()))
                    .ok_or(DECODE)
            }
            0 => Err(DECODE),
            NOT_FOUND => Ok(None),
            status => Err(status),
        }
    }

    /// `false` when the item exists, which stays as it is.
    pub(crate) fn add(service: &str, account: &str, group: &str, data: &[u8]) -> Result<bool, i32> {
        let mut pairs = query(service, account, group);
        // SAFETY: as in `query`.
        let (accessible, after_first_unlock, value) = unsafe {
            (
                kSecAttrAccessible,
                kSecAttrAccessibleAfterFirstUnlock,
                kSecValueData,
            )
        };
        pairs.push((
            constant(accessible),
            constant(after_first_unlock).into_CFType(),
        ));
        pairs.push((constant(value), CFData::from_buffer(data).into_CFType()));
        let attributes = CFDictionary::from_CFType_pairs(&pairs);
        let status = call(|| {
            // SAFETY: `attributes` is a valid dictionary that outlives the call, and a null result
            // pointer asks for nothing back.
            unsafe { SecItemAdd(attributes.as_concrete_TypeRef(), std::ptr::null_mut()) }
        });
        match status {
            0 => Ok(true),
            DUPLICATE => Ok(false),
            status => Err(status),
        }
    }

    pub(crate) fn update(
        service: &str,
        account: &str,
        group: &str,
        data: &[u8],
    ) -> Result<(), i32> {
        let query = CFDictionary::from_CFType_pairs(&query(service, account, group));
        // SAFETY: as in `query`.
        let value = unsafe { kSecValueData };
        let changes = CFDictionary::from_CFType_pairs(&[(
            constant(value),
            CFData::from_buffer(data).into_CFType(),
        )]);
        let status = call(|| {
            // SAFETY: both are valid dictionaries that outlive the call.
            unsafe { SecItemUpdate(query.as_concrete_TypeRef(), changes.as_concrete_TypeRef()) }
        });
        if status == 0 { Ok(()) } else { Err(status) }
    }

    /// `false` when there was no item.
    pub(crate) fn delete(service: &str, account: &str, group: &str) -> Result<bool, i32> {
        let query = CFDictionary::from_CFType_pairs(&query(service, account, group));
        let status = call(|| {
            // SAFETY: a valid dictionary that outlives the call.
            unsafe { SecItemDelete(query.as_concrete_TypeRef()) }
        });
        match status {
            0 => Ok(true),
            NOT_FOUND => Ok(false),
            status => Err(status),
        }
    }
}
