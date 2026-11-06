//! UIKit: haptics, opening a URL, the interface style and SF Symbols.

use block2::RcBlock;
use objc2::AllocAnyThread;
use objc2_core_foundation::{CGPoint, CGSize};
use objc2_foundation::NSString;
use objc2_ui_kit::{
    UIColor, UIGraphicsImageRenderer, UIGraphicsImageRendererFormat,
    UIGraphicsImageRendererFormatRange, UIImage, UIImageRenderingMode, UIImageSymbolConfiguration,
    UIImageSymbolWeight, UITraitCollection,
};

use crate::native::{
    HapticKind, SYMBOL_PIXELS_PER_POINT, guarded, symbol_canvas, symbol_weight_rank,
};

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

/// Hands an https URL to Safari (`external::open_external` has checked it). Main thread only;
/// `false` when it was not handed over.
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
                point_size * SYMBOL_PIXELS_PER_POINT,
                UIImageSymbolWeight(symbol_weight_rank(weight)),
            )
            .configurationWithTraitCollection(Some(&one_pixel_a_point));
            let image = UIImage::systemImageNamed_withConfiguration(
                &NSString::from_str(name),
                Some(&configuration),
            )?;
            // SAFETY: a property read of an image `systemImageNamed` just made for this call; no other thread holds it.
            let size = unsafe { image.size() };
            let (width, height) = symbol_canvas(size.width, size.height)?;
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
