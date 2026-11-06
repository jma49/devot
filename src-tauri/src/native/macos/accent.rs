//! The system accent colour and its changes.

use std::cell::Cell;
use std::panic::catch_unwind;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2_app_kit::{
    NSAppearance, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSColor, NSColorSpace,
};
use objc2_foundation::{
    NSDistributedNotificationCenter, NSNotification, NSOperationQueue, NSString, NSUserDefaults,
};

use crate::native::{AccentInfo, hex_from_unit_rgb};

/// macOS stores no `AppleAccentColor` value when the user picked Multicolor.
fn accent_is_multicolor() -> bool {
    NSUserDefaults::standardUserDefaults()
        .objectForKey(&NSString::from_str("AppleAccentColor"))
        .is_none()
}

fn accent_hex_under(appearance: &NSAppearance) -> Option<String> {
    let result = Cell::new(None);
    let resolve =
        RcBlock::new(|| {
            let color = NSColor::controlAccentColor();
            let srgb = color.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace());
            result.set(srgb.map(|c| {
                hex_from_unit_rgb(c.redComponent(), c.greenComponent(), c.blueComponent())
            }));
        });
    appearance.performAsCurrentDrawingAppearance(&resolve);
    result.take()
}

pub fn system_accent() -> AccentInfo {
    catch_unwind(|| {
        if accent_is_multicolor() {
            return AccentInfo::multicolor();
        }
        // SAFETY: the appearance names are static NSString constants exported
        // by AppKit.
        let (light_name, dark_name) = unsafe { (NSAppearanceNameAqua, NSAppearanceNameDarkAqua) };
        let light = NSAppearance::appearanceNamed(light_name).and_then(|a| accent_hex_under(&a));
        let dark = NSAppearance::appearanceNamed(dark_name).and_then(|a| accent_hex_under(&a));
        match (light, dark) {
            (Some(light), Some(dark)) => AccentInfo::system(light, dark),
            _ => AccentInfo::multicolor(),
        }
    })
    .unwrap_or_else(|_| AccentInfo::multicolor())
}

/// The observer lives for the rest of the process.
pub fn observe_accent_changes(on_change: impl Fn() + 'static) {
    let block = RcBlock::new(move |_note: NonNull<NSNotification>| on_change());
    let center = NSDistributedNotificationCenter::defaultCenter();
    // SAFETY: the name is a valid NSString, the main queue is a valid
    // operation queue, and the block outlives the observer (both leak).
    let observer = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(&NSString::from_str(
                "AppleColorPreferencesChangedNotification",
            )),
            None,
            Some(&NSOperationQueue::mainQueue()),
            &block,
        )
    };
    std::mem::forget(observer);
    std::mem::forget(block);
}
