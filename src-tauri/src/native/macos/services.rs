//! The Services menu's "New Devot Note": another app sends its selection here, and the app's
//! handler turns it into a quick capture the owner saves or cancels.

use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_app_kit::{
    NSApplication, NSPasteboard, NSPasteboardTypeString, NSPasteboardTypeURL,
    NSUpdateDynamicServices,
};
use objc2_foundation::{NSObject, NSObjectProtocol, NSString};

use crate::native::guarded;

/// What the selection held: its text and its URL, either of which may be missing.
pub type ServiceHandler = Box<dyn Fn(Option<String>, Option<String>)>;

thread_local! {
    static PROVIDER: RefCell<Option<(Retained<ServicesProvider>, ServiceHandler)>> =
        const { RefCell::new(None) };
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and
    // `ServicesProvider` implements no `Drop`.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DevotServicesProvider"]
    struct ServicesProvider;

    // SAFETY: NSObjectProtocol has no requirements beyond NSObject's.
    unsafe impl NSObjectProtocol for ServicesProvider {}

    impl ServicesProvider {
        /// `NSMessage` `newNote` in Info.plist's `NSServices`.
        #[unsafe(method(newNote:userData:error:))]
        fn new_note(
            &self,
            pasteboard: &NSPasteboard,
            _user_data: Option<&NSString>,
            _error: *mut *mut NSString,
        ) {
            let sent = guarded("W_NATIVE_SERVICE_READ", || Some(selection(pasteboard)));
            let Some((text, url)) = sent else { return };
            PROVIDER.with(|provider| {
                if let Some((_, handler)) = provider.borrow().as_ref() {
                    handler(text, url);
                }
            });
        }
    }
);

fn selection(pasteboard: &NSPasteboard) -> (Option<String>, Option<String>) {
    // SAFETY: both types are immutable AppKit constants.
    let (text_type, url_type) = unsafe { (NSPasteboardTypeString, NSPasteboardTypeURL) };
    let read = |kind| pasteboard.stringForType(kind).map(|text| text.to_string());
    (read(text_type), read(url_type))
}

/// Main thread only; a second call replaces the handler.
pub fn provide_services(handler: ServiceHandler) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    guarded("W_NATIVE_SERVICES", || {
        // SAFETY: a fresh allocation of an NSObject subclass with no fields.
        let provider: Retained<ServicesProvider> = unsafe { msg_send![mtm.alloc(), init] };
        let app = NSApplication::sharedApplication(mtm);
        // SAFETY: the provider responds to the message Info.plist names, and PROVIDER keeps it
        // alive for as long as AppKit holds it (AppKit does not retain it).
        unsafe { app.setServicesProvider(Some(&provider)) };
        PROVIDER.with(|slot| *slot.borrow_mut() = Some((provider, handler)));
        NSUpdateDynamicServices();
        Some(())
    })
    .is_some()
}
