//! iOS-only native code: UIKit calls through objc2 and one keychain call. Every UIKit call runs
//! inside `guarded`, which catches an Objective-C exception as well as a Rust panic, and every
//! object UIKit may withhold is checked for nil; a failure gives the caller's fallback.

use block2::RcBlock;
use objc2::AllocAnyThread;
use objc2_core_foundation::{CGPoint, CGSize};
use objc2_foundation::NSString;
use objc2_ui_kit::{
    UIColor, UIGraphicsImageRenderer, UIGraphicsImageRendererFormat,
    UIGraphicsImageRendererFormatRange, UIImage, UIImageRenderingMode, UIImageSymbolConfiguration,
    UIImageSymbolWeight, UITraitCollection,
};

use super::guarded;

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
