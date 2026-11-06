//! The general pasteboard: text, secrets and images.

use std::panic::{AssertUnwindSafe, catch_unwind};

use objc2::AllocAnyThread;
use objc2::msg_send;
use objc2::runtime::AnyObject;
use objc2::sel;
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSPasteboard, NSPasteboardTypePNG,
    NSPasteboardTypeString, NSPasteboardTypeTIFF,
};
use objc2_foundation::{NSData, NSDictionary, NSString};

use super::responds;

pub fn write_clipboard_text(text: &str) -> bool {
    catch_unwind(|| {
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        // SAFETY: `NSPasteboardTypeString` is an immutable AppKit constant
        // (macOS 10.6+), valid for the life of the process.
        let kind = unsafe { NSPasteboardTypeString };
        pasteboard.setString_forType(&NSString::from_str(text), kind)
    })
    .unwrap_or(false)
}

/// Marker types clipboard managers honour (nspasteboard.org): skip the item, keep no history.
const CONCEALED_TYPE: &str = "org.nspasteboard.ConcealedType";
const TRANSIENT_TYPE: &str = "org.nspasteboard.TransientType";

/// Puts a secret on the general pasteboard for this Mac only (no Universal Clipboard), marked
/// concealed and transient. Returns the pasteboard's change count, for
/// [`clear_clipboard_if_unchanged`].
pub fn write_secret_clipboard_text(text: &str) -> Option<isize> {
    catch_unwind(|| write_secret_text_to(&NSPasteboard::generalPasteboard(), text)).unwrap_or(None)
}

fn write_secret_text_to(pasteboard: &NSPasteboard, text: &str) -> Option<isize> {
    pasteboard.prepareForNewContentsWithOptions(
        objc2_app_kit::NSPasteboardContentsOptions::CurrentHostOnly,
    );
    // SAFETY: `NSPasteboardTypeString` is an immutable AppKit constant
    // (macOS 10.6+), valid for the life of the process.
    let kind = unsafe { NSPasteboardTypeString };
    let marked = [CONCEALED_TYPE, TRANSIENT_TYPE].iter().all(|marker| {
        pasteboard.setData_forType(Some(&NSData::new()), &NSString::from_str(marker))
    });
    (marked && pasteboard.setString_forType(&NSString::from_str(text), kind))
        .then(|| pasteboard.changeCount())
}

/// Clears the general pasteboard when nothing was put on it since `count`.
pub fn clear_clipboard_if_unchanged(count: isize) {
    let _ = catch_unwind(|| clear_if_unchanged(&NSPasteboard::generalPasteboard(), count));
}

fn clear_if_unchanged(pasteboard: &NSPasteboard, count: isize) -> bool {
    pasteboard.changeCount() == count && {
        pasteboard.clearContents();
        true
    }
}

pub struct PasteboardImage {
    pub png: Option<Vec<u8>>,
    pub tiff: Vec<u8>,
}

/// A PNG keeps its own bytes; other formats are converted. Safe off the main thread (NSImage and
/// NSBitmapImageRep decode on any thread), so the work never stalls the UI. `E_IMAGE_TOO_LARGE`
/// when its header gives more than `max_pixels` pixels: nothing is decoded then.
/// AppKit's temporaries (several decoded copies) go in an autorelease pool of the call's own: a
/// thread with no pool keeps them until it exits, and a blocking-pool thread lives on for 10 s and
/// more, so a few copies of a large photo held hundreds of MB.
pub fn pasteboard_image(bytes: &[u8], max_pixels: u64) -> Result<PasteboardImage, &'static str> {
    catch_unwind(AssertUnwindSafe(|| {
        objc2::rc::autoreleasepool(|_| {
            let data = NSData::with_bytes(bytes);
            let header = NSBitmapImageRep::imageRepWithData(&data).ok_or("E_IMAGE_UNREADABLE")?;
            let side = |n: isize| u64::try_from(n).unwrap_or(0);
            if side(header.pixelsWide()).saturating_mul(side(header.pixelsHigh())) > max_pixels {
                return Err("E_IMAGE_TOO_LARGE");
            }
            let image =
                NSImage::initWithData(NSImage::alloc(), &data).ok_or("E_IMAGE_UNREADABLE")?;
            let tiff = image.TIFFRepresentation().ok_or("E_IMAGE_UNREADABLE")?;
            let png = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                Some(bytes.to_vec())
            } else {
                NSBitmapImageRep::imageRepWithData(&tiff).and_then(|bitmap| {
                    // SAFETY: a public AppKit API (macOS 10.0+) called on a
                    // live bitmap with an empty properties dictionary; nil
                    // is checked.
                    unsafe {
                        bitmap.representationUsingType_properties(
                            NSBitmapImageFileType::PNG,
                            &NSDictionary::new(),
                        )
                    }
                    .map(|png| png.to_vec())
                })
            };
            Ok(PasteboardImage {
                png,
                tiff: tiff.to_vec(),
            })
        })
    }))
    .unwrap_or(Err("E_IMAGE_UNREADABLE"))
}

pub fn write_image(pasteboard: &NSPasteboard, image: &PasteboardImage) -> bool {
    catch_unwind(AssertUnwindSafe(|| {
        pasteboard.clearContents();
        // SAFETY: both types are immutable AppKit constants (macOS 10.6+),
        // valid for the life of the process.
        let (png_type, tiff_type) = unsafe { (NSPasteboardTypePNG, NSPasteboardTypeTIFF) };
        let wrote_png = image.png.as_ref().is_some_and(|png| {
            pasteboard.setData_forType(Some(&NSData::with_bytes(png)), png_type)
        });
        let wrote_tiff =
            pasteboard.setData_forType(Some(&NSData::with_bytes(&image.tiff)), tiff_type);
        wrote_png || wrote_tiff
    }))
    .unwrap_or(false)
}

pub fn write_clipboard_image(image: &PasteboardImage) -> bool {
    write_image(&NSPasteboard::generalPasteboard(), image)
}

/// Uses a private pasteboard (the user's clipboard is left alone). Run on the main thread.
pub fn self_test_image_pasteboard(png: &[u8]) -> Result<(), &'static str> {
    let owned = png.to_vec();
    let image = std::thread::spawn(move || pasteboard_image(&owned, u64::MAX))
        .join()
        .map_err(|_| "E_IMAGE_DECODE_PANICKED")?
        .map_err(|_| "E_IMAGE_NOT_DECODED")?;
    if image.png.as_deref() != Some(png) {
        return Err("E_IMAGE_PNG_NOT_KEPT");
    }
    if pasteboard_image(b"not an image", u64::MAX).is_ok() {
        return Err("E_IMAGE_TOOK_NON_IMAGE");
    }
    let pasteboard = NSPasteboard::pasteboardWithUniqueName();
    let result = (|| {
        if !write_image(&pasteboard, &image) {
            return Err("E_IMAGE_PASTEBOARD_NOT_WRITTEN");
        }
        // SAFETY: immutable AppKit constants, as above.
        let (png_type, tiff_type) = unsafe { (NSPasteboardTypePNG, NSPasteboardTypeTIFF) };
        let png_back = pasteboard
            .dataForType(png_type)
            .ok_or("E_IMAGE_PASTEBOARD_NO_PNG")?;
        if png_back.to_vec() != png {
            return Err("E_IMAGE_PASTEBOARD_BAD_PNG");
        }
        pasteboard
            .dataForType(tiff_type)
            .ok_or("E_IMAGE_PASTEBOARD_NO_TIFF")?;
        Ok(())
    })();
    let object: &AnyObject = &pasteboard;
    // SAFETY: `object` is a live NSPasteboard; the selector is checked
    // before it is sent, and it takes no arguments and returns nothing.
    unsafe {
        if responds(
            object as *const AnyObject as *mut AnyObject,
            sel!(releaseGlobally),
        ) {
            let _: () = msg_send![object, releaseGlobally];
        }
    }
    result
}

/// `Ok(None)` when the pasteboard holds no text; an error code when AppKit failed.
pub fn read_clipboard_text() -> Result<Option<String>, &'static str> {
    catch_unwind(|| {
        let pasteboard = NSPasteboard::generalPasteboard();
        // SAFETY: `NSPasteboardTypeString` is an immutable AppKit constant
        // (macOS 10.6+), valid for the life of the process.
        let kind = unsafe { NSPasteboardTypeString };
        pasteboard.stringForType(kind).map(|text| text.to_string())
    })
    .map_err(|_| "E_CLIPBOARD_READ_FAILED")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pasteboard of the test's own, so the user's clipboard is never touched.
    struct OwnPasteboard(objc2::rc::Retained<NSPasteboard>);

    impl Drop for OwnPasteboard {
        fn drop(&mut self) {
            // SAFETY: `releaseGlobally` is public AppKit API (macOS 10.0+) on a live pasteboard
            // this test made; it takes no arguments and returns nothing.
            let () = unsafe { msg_send![&*self.0, releaseGlobally] };
        }
    }

    #[test]
    fn a_secret_is_marked_concealed_and_cleared_only_when_nothing_replaced_it() {
        let own = OwnPasteboard(NSPasteboard::pasteboardWithUniqueName());
        let pasteboard = &own.0;
        let count = write_secret_text_to(pasteboard, "secret").expect("written");
        // SAFETY: an immutable AppKit constant (macOS 10.6+).
        let kind = unsafe { NSPasteboardTypeString };
        assert_eq!(
            pasteboard.stringForType(kind).map(|s| s.to_string()),
            Some("secret".to_string())
        );
        let types: Vec<String> = pasteboard
            .types()
            .map(|types| types.iter().map(|t| t.to_string()).collect())
            .unwrap_or_default();
        assert!(types.iter().any(|t| t == CONCEALED_TYPE));
        assert!(types.iter().any(|t| t == TRANSIENT_TYPE));

        assert!(!clear_if_unchanged(pasteboard, count - 1));
        assert!(pasteboard.stringForType(kind).is_some());
        assert!(clear_if_unchanged(pasteboard, count));
        assert!(pasteboard.stringForType(kind).is_none());

        let count = write_secret_text_to(pasteboard, "secret").expect("written");
        pasteboard.clearContents();
        pasteboard.setString_forType(&NSString::from_str("the user's copy"), kind);
        assert!(!clear_if_unchanged(pasteboard, count));
        assert!(pasteboard.stringForType(kind).is_some());
    }
}
