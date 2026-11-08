//! Look Up, speech and the fonts they draw in.

use std::cell::RefCell;
use std::panic::{AssertUnwindSafe, catch_unwind};

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::sel;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSFont, NSFontManager, NSFontTraitMask};
use objc2_foundation::{NSData, NSDictionary, NSNumber, NSPoint, NSRect, NSSize, NSString};
use objc2_web_kit::{WKWebView, WKWebViewConfiguration};

use super::responds;
use super::symbols::symbol_weight;
use crate::native::{FontSource, LookUpStyle, closest_face, guarded, look_up_style};

/// Must run on the main thread; none when it is not.
pub fn font_families() -> Vec<String> {
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        return Vec::new();
    };
    catch_unwind(AssertUnwindSafe(|| {
        objc2::rc::autoreleasepool(|_| {
            let manager = objc2_app_kit::NSFontManager::sharedFontManager(mtm);
            manager
                .availableFontFamilies()
                .iter()
                .map(|name| name.to_string())
                .collect()
        })
    }))
    .unwrap_or_default()
}

thread_local! {
    static SYNTHESIZER: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextServices {
    pub look_up: bool,
    pub start_speaking: bool,
    pub stop_speaking: bool,
}

/// # Safety
/// `web_view` must be null or point to a live `WKWebView`.
unsafe fn text_services(web_view: *mut AnyObject) -> TextServices {
    if web_view.is_null() {
        return TextServices {
            look_up: false,
            start_speaking: false,
            stop_speaking: false,
        };
    }
    // SAFETY: `web_view` is live (caller contract); every NSObject responds
    // to respondsToSelector:.
    unsafe {
        TextServices {
            look_up: responds(web_view, sel!(showDefinitionForAttributedString:atPoint:)),
            start_speaking: responds(web_view, sel!(startSpeaking:)),
            stop_speaking: responds(web_view, sel!(stopSpeaking:)),
        }
    }
}

/// `Err` carries a code: the point is outside the view, or the web view cannot look up.
pub fn look_up(
    webview: &tauri::webview::PlatformWebview,
    text: &str,
    x: f64,
    y: f64,
    style: &LookUpStyle,
) -> Result<(), &'static str> {
    let web_view: *mut AnyObject = webview.inner().cast();
    guarded("W_NATIVE_LOOK_UP_FAILED", || {
        // SAFETY: `inner()` is the live WKWebView owned by the window; the
        // call runs on the main thread (`with_webview`).
        Some(unsafe { look_up_in(web_view, text, x, y, style) })
    })
    .unwrap_or(Err("E_LOOK_UP_FAILED"))
}

/// # Safety
/// `web_view` must be null or point to a live `WKWebView`; main thread.
unsafe fn look_up_in(
    web_view: *mut AnyObject,
    text: &str,
    x: f64,
    y: f64,
    style: &LookUpStyle,
) -> Result<(), &'static str> {
    // SAFETY: `web_view` is null or live (caller contract).
    if !unsafe { text_services(web_view) }.look_up {
        return Err("E_LOOK_UP_UNAVAILABLE");
    }
    // SAFETY: the view responds to `bounds` (every NSView does).
    let bounds: NSRect = unsafe { msg_send![web_view, bounds] };
    if x > bounds.size.width || y > bounds.size.height {
        return Err("E_LOOK_UP_OUTSIDE_VIEW");
    }
    let class = AnyClass::get(c"NSAttributedString").ok_or("E_LOOK_UP_UNAVAILABLE")?;
    let string = NSString::from_str(text);
    // The word is drawn in the text's own font, so the highlight covers it.
    let font = look_up_font(style);
    // SAFETY: `NSFontAttributeName` is an immutable AppKit constant, valid
    // for the life of the process.
    let key = unsafe { objc2_app_kit::NSFontAttributeName };
    let attributes = NSDictionary::<NSString, AnyObject>::from_slices(&[key], &[font.as_ref()]);
    // SAFETY: `alloc` and `initWithString:attributes:` are
    // NSAttributedString's own designated pair; `string` is an NSString,
    // `attributes` maps NSFontAttributeName to an NSFont; the result is owned.
    let attributed: Option<Retained<AnyObject>> = unsafe {
        let fresh: *mut AnyObject = msg_send![class, alloc];
        let made: *mut AnyObject =
            msg_send![fresh, initWithString: &*string, attributes: &*attributes];
        Retained::from_raw(made)
    };
    let attributed = attributed.ok_or("E_LOOK_UP_UNAVAILABLE")?;
    // SAFETY: the selector was checked above; the string is a live
    // NSAttributedString and the point lies inside the view.
    unsafe {
        let _: () = msg_send![
            web_view,
            showDefinitionForAttributedString: &*attributed,
            atPoint: NSPoint::new(x, y)
        ];
    }
    Ok(())
}

fn look_up_font(style: &LookUpStyle) -> Retained<NSFont> {
    let size = style.size.unwrap_or_else(NSFont::systemFontSize);
    let weight = symbol_weight(style.weight);
    let found = style.sources.iter().find_map(|source| match source {
        FontSource::System => Some(NSFont::systemFontOfSize_weight(size, weight)),
        FontSource::Monospaced => Some(NSFont::monospacedSystemFontOfSize_weight(size, weight)),
        FontSource::Installed(family) => installed_font(family, style, size),
        FontSource::File(bytes) => file_font(bytes, size, weight, style.italic),
    });
    let font = found.unwrap_or_else(|| NSFont::systemFontOfSize_weight(size, weight));
    if !style.italic {
        return font;
    }
    let mtm = objc2::MainThreadMarker::new();
    match mtm {
        // An installed family was asked for italic already; for the others
        // the font manager finds the italic face, or keeps the font.
        Some(mtm) => NSFontManager::sharedFontManager(mtm)
            .convertFont_toHaveTrait(&font, NSFontTraitMask::ItalicFontMask),
        None => font,
    }
}

/// None when the family is not installed.
fn installed_font(family: &str, style: &LookUpStyle, size: f64) -> Option<Retained<NSFont>> {
    let manager = NSFontManager::sharedFontManager(objc2::MainThreadMarker::new()?);
    let family = NSString::from_str(family);
    let mut traits = NSFontTraitMask::empty();
    if style.italic {
        traits |= NSFontTraitMask::ItalicFontMask;
    }
    if style.manager_weight >= 9 {
        traits |= NSFontTraitMask::BoldFontMask;
    }
    manager
        .fontWithFamily_traits_weight_size(&family, traits, style.manager_weight, size)
        .or_else(|| {
            manager.fontWithFamily_traits_weight_size(&family, NSFontTraitMask::empty(), 5, size)
        })
}

#[link(name = "CoreText", kind = "framework")]
unsafe extern "C" {
    fn CTFontManagerCreateFontDescriptorsFromData(data: *const AnyObject) -> *mut AnyObject;
    fn CTFontCreateWithFontDescriptor(
        descriptor: *const AnyObject,
        size: f64,
        matrix: *const std::ffi::c_void,
    ) -> *mut AnyObject;
    fn CTFontDescriptorCopyAttribute(
        descriptor: *const AnyObject,
        attribute: *const AnyObject,
    ) -> *mut AnyObject;
    #[allow(non_upper_case_globals)]
    static kCTFontTraitsAttribute: *const AnyObject;
    #[allow(non_upper_case_globals)]
    static kCTFontWeightTrait: *const AnyObject;
    #[allow(non_upper_case_globals)]
    static kCTFontSymbolicTrait: *const AnyObject;
}

const ITALIC_TRAIT: u32 = 1 << 0;

fn face_traits(descriptor: &AnyObject) -> Option<(f64, bool)> {
    // SAFETY: `descriptor` is a live CTFontDescriptor and the attribute an
    // immutable CoreText constant; the result is a +1 CFDictionary (toll-free
    // bridged with NSDictionary) or null, owned here.
    let traits: Retained<NSDictionary<NSString, AnyObject>> = unsafe {
        let made = CTFontDescriptorCopyAttribute(descriptor, kCTFontTraitsAttribute);
        Retained::from_raw(made.cast())?
    };
    let number = |key: *const AnyObject| {
        // SAFETY: `key` is an immutable CoreText CFString constant (toll-free
        // bridged with NSString), valid for the life of the process.
        let key = unsafe { key.cast::<NSString>().as_ref() }?;
        traits.objectForKey(key)?.downcast::<NSNumber>().ok()
    };
    // SAFETY: reading immutable CoreText constants.
    let (weight_key, symbolic_key) = unsafe { (kCTFontWeightTrait, kCTFontSymbolicTrait) };
    let weight = number(weight_key)?.as_f64();
    let symbolic = number(symbolic_key).map_or(0, |bits| bits.as_u32());
    Some((weight, symbolic & ITALIC_TRAIT != 0))
}

/// Made for this call only: nothing is registered with the system.
fn file_font(bytes: &[u8], size: f64, weight: f64, italic: bool) -> Option<Retained<NSFont>> {
    let data = NSData::with_bytes(bytes);
    // SAFETY: NSData is toll-free bridged with CFData; the function returns
    // a +1 CFArray (toll-free bridged with NSArray) or null, owned here.
    let descriptors: Retained<objc2_foundation::NSArray<AnyObject>> = unsafe {
        let made = CTFontManagerCreateFontDescriptorsFromData(Retained::as_ptr(&data).cast());
        Retained::from_raw(made.cast())?
    };
    let descriptors: Vec<_> = descriptors.iter().collect();
    let faces: Vec<_> = descriptors.iter().map(|face| face_traits(face)).collect();
    let descriptor = descriptors.get(closest_face(&faces, weight, italic))?;
    // SAFETY: `descriptor` is a CTFontDescriptor from the array above; a null
    // matrix is the identity; the result is a +1 CTFont, which is an NSFont.
    unsafe {
        let made =
            CTFontCreateWithFontDescriptor(Retained::as_ptr(descriptor), size, std::ptr::null());
        Retained::from_raw(made.cast())
    }
}

/// `text`, the selection the page sends, is spoken by a speech synthesizer; without it the web view
/// speaks its own selection (the system's Speech action). A start stops the other voice first;
/// stopping stops both.
pub fn speak(
    webview: &tauri::webview::PlatformWebview,
    start: bool,
    text: Option<&str>,
) -> Result<(), &'static str> {
    let web_view: *mut AnyObject = webview.inner().cast();
    guarded("W_NATIVE_SPEECH_FAILED", || {
        // SAFETY: `inner()` is the live WKWebView owned by the window; the
        // call runs on the main thread (`with_webview`).
        Some(unsafe { speak_in(web_view, start, text) })
    })
    .unwrap_or(Err("E_SPEECH_FAILED"))
}

/// # Safety
/// `web_view` must be null or point to a live `WKWebView`; main thread.
unsafe fn speak_in(
    web_view: *mut AnyObject,
    start: bool,
    text: Option<&str>,
) -> Result<(), &'static str> {
    // SAFETY: `web_view` is null or live (caller contract).
    let services = unsafe { text_services(web_view) };
    let nothing: *const AnyObject = std::ptr::null();
    for step in speech_steps(start, text, services)? {
        match step {
            SpeechStep::StopWebView => {
                // SAFETY: `speech_steps` names this step only when the
                // selector was checked; a nil sender is allowed.
                unsafe {
                    let _: () = msg_send![web_view, stopSpeaking: nothing];
                }
            }
            SpeechStep::StartWebView => {
                // SAFETY: `speech_steps` names this step only when the
                // selector was checked; a nil sender is allowed.
                unsafe {
                    let _: () = msg_send![web_view, startSpeaking: nothing];
                }
            }
            SpeechStep::StopSynthesizer => stop_synthesizer(),
            SpeechStep::Synthesize(text) => speak_with_synthesizer(text)?,
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum SpeechStep<'a> {
    StopWebView,
    StopSynthesizer,
    StartWebView,
    Synthesize(&'a str),
}

/// Every start first stops the other voice, so only one speaks at a time. The page's text comes
/// first: the editor draws only the lines near the view, so the web view's own selection can hold
/// a fraction of a long one.
fn speech_steps(
    start: bool,
    text: Option<&str>,
    services: TextServices,
) -> Result<Vec<SpeechStep<'_>>, &'static str> {
    let stop_web_view = services.stop_speaking.then_some(SpeechStep::StopWebView);
    let then = match (start, text) {
        (false, _) => SpeechStep::StopSynthesizer,
        (true, Some(text)) => SpeechStep::Synthesize(text),
        (true, None) if services.start_speaking => {
            return Ok(vec![SpeechStep::StopSynthesizer, SpeechStep::StartWebView]);
        }
        (true, None) => return Err("E_SPEECH_NOTHING_TO_SAY"),
    };
    Ok(stop_web_view.into_iter().chain([then]).collect())
}

fn stop_synthesizer() {
    SYNTHESIZER.with(|cell| {
        if let Some(synthesizer) = cell.borrow().as_ref() {
            let object = Retained::as_ptr(synthesizer).cast_mut();
            // SAFETY: `object` is the live synthesizer kept here; checked
            // before the call.
            unsafe {
                if responds(object, sel!(stopSpeaking)) {
                    let _: () = msg_send![object, stopSpeaking];
                }
            }
        }
    });
}

fn speak_with_synthesizer(text: &str) -> Result<(), &'static str> {
    let class = AnyClass::get(c"NSSpeechSynthesizer").ok_or("E_SPEECH_UNAVAILABLE")?;
    SYNTHESIZER.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            // SAFETY: `alloc` and `init` are NSSpeechSynthesizer's own pair;
            // the result is owned.
            *slot = unsafe {
                let fresh: *mut AnyObject = msg_send![class, alloc];
                let made: *mut AnyObject = msg_send![fresh, init];
                Retained::from_raw(made)
            };
        }
        let synthesizer = slot.as_ref().ok_or("E_SPEECH_UNAVAILABLE")?;
        let object = Retained::as_ptr(synthesizer).cast_mut();
        let string = NSString::from_str(text);
        // SAFETY: `object` is the live synthesizer kept in the slot; the
        // selectors are checked before the calls; `string` is an NSString.
        unsafe {
            if !responds(object, sel!(startSpeakingString:)) {
                return Err("E_SPEECH_UNAVAILABLE");
            }
            if responds(object, sel!(stopSpeaking)) {
                let _: () = msg_send![object, stopSpeaking];
            }
            let started: Bool = msg_send![object, startSpeakingString: &*string];
            if !started.as_bool() {
                return Err("E_SPEECH_NOT_STARTED");
            }
        }
        Ok(())
    })
}

/// Checks on a real web view, without showing anything, that a missing selector gives a code, not a
/// crash. Main thread only.
#[doc(hidden)]
pub fn self_test_look_up_speech() -> Result<(), &'static str> {
    let mtm = MainThreadMarker::new().ok_or("E_NATIVE_NOT_MAIN_THREAD")?;
    let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(400.0, 300.0));
    // SAFETY: a fresh configuration, made on the main thread.
    let config = unsafe { WKWebViewConfiguration::new(mtm) };
    // SAFETY: a fresh allocation with a valid frame and configuration.
    let web_view =
        unsafe { WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), rect, &config) };
    let object = Retained::as_ptr(&web_view).cast::<AnyObject>().cast_mut();
    // SAFETY: `object` is the live web view retained above.
    let services = unsafe { text_services(object) };
    if !services.look_up {
        return Err("E_LOOK_UP_SELECTOR_MISSING");
    }
    if !services.start_speaking || !services.stop_speaking {
        return Err("E_SPEECH_SELECTORS_MISSING");
    }
    let style = look_up_style(None, |_| None);
    // A point outside the view is refused before anything shows.
    // SAFETY: `object` is the live web view retained above.
    let outside = unsafe { look_up_in(object, "word", 10_000.0, 10_000.0, &style) };
    if outside != Err("E_LOOK_UP_OUTSIDE_VIEW") {
        return Err("E_LOOK_UP_OUTSIDE_NOT_REFUSED");
    }
    // Something that is not a web view has none of it, and says so.
    // SAFETY: an NSObject is live and responds to respondsToSelector:.
    let plain: Retained<objc2_foundation::NSObject> = objc2_foundation::NSObject::new();
    let plain_object = Retained::as_ptr(&plain).cast::<AnyObject>().cast_mut();
    // SAFETY: `plain_object` is the live object retained above.
    if unsafe { look_up_in(plain_object, "word", 1.0, 1.0, &style) } != Err("E_LOOK_UP_UNAVAILABLE")
    {
        return Err("E_LOOK_UP_NOT_GUARDED");
    }
    // SAFETY: as above; stopping speech with nothing speaking is harmless.
    if unsafe { speak_in(plain_object, false, None) }.is_err() {
        return Err("E_SPEECH_STOP_NOT_GUARDED");
    }
    // SAFETY: as above.
    if unsafe { speak_in(plain_object, true, None) } != Err("E_SPEECH_NOTHING_TO_SAY") {
        return Err("E_SPEECH_START_NOT_GUARDED");
    }
    Ok(())
}

/// Main thread only.
#[doc(hidden)]
pub fn self_test_look_up_fonts() -> Result<(), &'static str> {
    use crate::native::LookUpFont;
    MainThreadMarker::new().ok_or("E_NATIVE_NOT_MAIN_THREAD")?;
    let font = |family: &str, weight: f64, italic: bool, file: Option<Vec<u8>>| {
        let request = LookUpFont {
            family: family.to_string(),
            size: 21.0,
            weight,
            italic,
        };
        look_up_font(&look_up_style(Some(&request), |_| file.clone()))
    };
    let family = |font: &NSFont| font.familyName().map(|name| name.to_string());
    let traits = |font: &NSFont| {
        let mtm = MainThreadMarker::new().expect("main thread");
        NSFontManager::sharedFontManager(mtm).traitsOfFont(font)
    };
    let menlo = font("Menlo, monospace", 400.0, false, None);
    if family(&menlo).as_deref() != Some("Menlo") || menlo.pointSize() != 21.0 {
        return Err("E_LOOK_UP_FONT_INSTALLED");
    }
    let bold_italic = font("\"Menlo\"", 700.0, true, None);
    let wanted = NSFontTraitMask::BoldFontMask | NSFontTraitMask::ItalicFontMask;
    if !traits(&bold_italic).contains(wanted) {
        return Err("E_LOOK_UP_FONT_TRAITS");
    }
    let system = NSFont::systemFontOfSize(21.0);
    for list in [
        "-apple-system",
        "No Such Font Family",
        "\"Devot Font Gone ttf\"",
    ] {
        if family(&font(list, 400.0, false, None)) != family(&system) {
            return Err("E_LOOK_UP_FONT_FALLBACK");
        }
    }
    let mono = NSFont::monospacedSystemFontOfSize_weight(21.0, symbol_weight("regular"));
    if family(&font("ui-monospace, Menlo", 400.0, false, None)) != family(&mono) {
        return Err("E_LOOK_UP_FONT_MONOSPACED");
    }
    // Bytes that are not a font fall through to the next family.
    let garbage = font(
        "\"Devot Font X ttf\", Menlo",
        400.0,
        false,
        Some(vec![0; 64]),
    );
    if family(&garbage).as_deref() != Some("Menlo") {
        return Err("E_LOOK_UP_FONT_FILE_INVALID");
    }
    if let Ok(bytes) = std::fs::read("/System/Library/Fonts/Menlo.ttc") {
        let from_file = look_up_font(&LookUpStyle {
            sources: vec![FontSource::File(bytes.clone())],
            ..look_up_style(None, |_| None)
        });
        if family(&from_file).as_deref() != Some("Menlo") {
            return Err("E_LOOK_UP_FONT_FILE");
        }
        let bold_italic = font("\"Devot Font Menlo ttf\"", 700.0, true, Some(bytes.clone()));
        if family(&bold_italic).as_deref() != Some("Menlo")
            || !traits(&bold_italic).contains(wanted)
        {
            return Err("E_LOOK_UP_FONT_FILE_FACE");
        }
        let regular = font("\"Devot Font Menlo ttf\"", 400.0, false, Some(bytes));
        if traits(&regular).intersects(wanted) {
            return Err("E_LOOK_UP_FONT_FILE_FACE");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: TextServices = TextServices {
        look_up: true,
        start_speaking: true,
        stop_speaking: true,
    };

    #[test]
    fn speaks_the_text_the_page_sends_and_the_web_views_selection_only_without_it() {
        let no_web_speech = TextServices {
            start_speaking: false,
            stop_speaking: false,
            ..ALL
        };
        assert_eq!(
            speech_steps(true, Some("a"), no_web_speech),
            Ok(vec![SpeechStep::Synthesize("a")])
        );
        assert_eq!(
            speech_steps(true, None, no_web_speech),
            Err("E_SPEECH_NOTHING_TO_SAY")
        );
    }

    #[test]
    fn a_start_stops_the_other_voice_first() {
        assert_eq!(
            speech_steps(true, Some("a long selection"), ALL),
            Ok(vec![
                SpeechStep::StopWebView,
                SpeechStep::Synthesize("a long selection")
            ])
        );
        assert_eq!(
            speech_steps(true, None, ALL),
            Ok(vec![SpeechStep::StopSynthesizer, SpeechStep::StartWebView])
        );
    }

    #[test]
    fn stopping_stops_both_voices() {
        assert_eq!(
            speech_steps(false, None, ALL),
            Ok(vec![SpeechStep::StopWebView, SpeechStep::StopSynthesizer])
        );
    }
}
