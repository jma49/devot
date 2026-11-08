//! UIKit: opening a URL, the interface style, the share sheet and SF Symbols.

use block2::RcBlock;
use objc2::AllocAnyThread;
use objc2_core_foundation::{CGPoint, CGSize};
use objc2_foundation::NSString;
use objc2_ui_kit::{
    UIColor, UIGraphicsImageRenderer, UIGraphicsImageRendererFormat,
    UIGraphicsImageRendererFormatRange, UIImage, UIImageRenderingMode, UIImageSymbolConfiguration,
    UIImageSymbolWeight, UITraitCollection,
};

use crate::native::{SYMBOL_PIXELS_PER_POINT, guarded, symbol_canvas, symbol_weight_rank};

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

/// The key window's top-most view controller that is not on its way out; with no key window, the
/// first window's.
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
