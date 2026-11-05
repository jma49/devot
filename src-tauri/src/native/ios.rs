//! iOS-only native code: UIKit calls through objc2, one keychain call and the StoreKit bridge. Every UIKit call runs
//! inside `guarded`, which catches an Objective-C exception as well as a Rust panic, and every
//! object UIKit may withhold is checked for nil; a failure gives the caller's fallback.

use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use block2::RcBlock;
use objc2::AllocAnyThread;
use objc2_core_foundation::{CGPoint, CGSize};
use objc2_foundation::NSString;
use objc2_ui_kit::{
    UIColor, UIGraphicsImageRenderer, UIGraphicsImageRendererFormat,
    UIGraphicsImageRendererFormatRange, UIImage, UIImageRenderingMode, UIImageSymbolConfiguration,
    UIImageSymbolWeight, UITraitCollection,
};

use tokio::sync::oneshot;

use super::{HapticKind, guarded};

/// On the main thread only (`native::haptic` sends it there); off it, nothing plays.
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

/// Gives every window of every connected scene the interface style (`native::interface_style`), so
/// UIKit's chrome and the web view's `prefers-color-scheme` follow it. Main thread only.
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

/// One call at a time (`native::render_one_at_a_time`) on a blocking thread, where UIKit's images
/// and image renderers may be used. The symbol is laid out for a display scale of 1, on whole points
/// as AppKit lays it out (for the screen's scale UIKit sizes it in thirds of a point, and it sits
/// higher in its PNG than on the Mac). UIKit's temporaries go in an autorelease pool of the call's
/// own, as the thread has none to empty.
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
    STORE_CALLS.lock().unwrap_or_else(|e| e.into_inner())
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

#[cfg(test)]
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
