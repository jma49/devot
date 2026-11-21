//! The languages set for this app alone: its own `AppleLanguages` default, which Settings >
//! General > Language writes and System Settings > Language & Region > Applications writes too.

use objc2::runtime::AnyObject;
use objc2_foundation::{NSArray, NSBundle, NSString, NSUserDefaults};

const KEY: &str = "AppleLanguages";
const GLOBAL_DOMAIN: &str = "NSGlobalDomain";

/// None while the app follows the system's languages.
pub fn app_languages() -> Option<Vec<String>> {
    languages_in(&NSBundle::mainBundle().bundleIdentifier()?)
}

/// The languages set in System Settings, read afresh: the process's own list
/// (`NSLocale.preferredLanguages`) holds the app's choice as it was at launch.
pub fn system_languages() -> Option<Vec<String>> {
    languages_in(&NSString::from_str(GLOBAL_DOMAIN))
}

fn languages_in(domain: &NSString) -> Option<Vec<String>> {
    let domain = NSUserDefaults::standardUserDefaults().persistentDomainForName(domain)?;
    let value = domain.objectForKey(&NSString::from_str(KEY))?;
    let list = value.downcast_ref::<NSArray>()?;
    Some(
        list.to_vec()
            .iter()
            .filter_map(|tag| tag.downcast_ref::<NSString>().map(NSString::to_string))
            .collect(),
    )
}

/// The system's own panels read it from the next launch: they take their languages once per process.
pub fn set_app_languages(tags: Option<&[&str]>) {
    let defaults = NSUserDefaults::standardUserDefaults();
    let key = NSString::from_str(KEY);
    let Some(tags) = tags else {
        defaults.removeObjectForKey(&key);
        return;
    };
    let strings: Vec<_> = tags.iter().map(|tag| NSString::from_str(tag)).collect();
    let list = NSArray::from_retained_slice(&strings);
    let object: &AnyObject = &list;
    // SAFETY: `AppleLanguages` holds an array of language tags, and `list` is an NSArray of
    // NSStrings that lives for the call; the defaults copy it.
    unsafe { defaults.setObject_forKey(Some(object), &key) };
}
