//! SF Symbols drawn as PNGs.

use std::panic::catch_unwind;

use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSFontWeightBlack, NSFontWeightBold,
    NSFontWeightHeavy, NSFontWeightLight, NSFontWeightMedium, NSFontWeightRegular,
    NSFontWeightSemibold, NSFontWeightThin, NSFontWeightUltraLight, NSImage,
    NSImageSymbolConfiguration,
};
use objc2_foundation::{NSDictionary, NSString};

use crate::native::SYMBOL_PIXELS_PER_POINT;

/// One call at a time (`native::render_one_at_a_time`); AppKit's temporaries go in an autorelease
/// pool of the call's own, as a blocking thread has none to empty.
pub fn symbol_png(name: &str, point_size: f64, weight: &str) -> Option<Vec<u8>> {
    catch_unwind(|| {
        objc2::rc::autoreleasepool(|_| {
            // SAFETY: these are public AppKit APIs (macOS 11+) called with
            // valid, owned arguments; every result is checked for nil.
            unsafe {
                let image = NSImage::imageWithSystemSymbolName_accessibilityDescription(
                    &NSString::from_str(name),
                    None,
                )?;
                let configuration = NSImageSymbolConfiguration::configurationWithPointSize_weight(
                    point_size * SYMBOL_PIXELS_PER_POINT,
                    symbol_weight(weight),
                );
                let image = image.imageWithSymbolConfiguration(&configuration)?;
                let tiff = image.TIFFRepresentation()?;
                let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)?;
                let png = bitmap.representationUsingType_properties(
                    NSBitmapImageFileType::PNG,
                    &NSDictionary::new(),
                )?;
                Some(png.to_vec())
            }
        })
    })
    .ok()
    .flatten()
}

pub(super) fn symbol_weight(name: &str) -> f64 {
    // SAFETY: these are immutable AppKit constants (macOS 10.11+), valid for
    // the life of the process.
    unsafe {
        match name {
            "ultralight" => NSFontWeightUltraLight,
            "thin" => NSFontWeightThin,
            "light" => NSFontWeightLight,
            "medium" => NSFontWeightMedium,
            "semibold" => NSFontWeightSemibold,
            "bold" => NSFontWeightBold,
            "heavy" => NSFontWeightHeavy,
            "black" => NSFontWeightBlack,
            _ => NSFontWeightRegular,
        }
    }
}
