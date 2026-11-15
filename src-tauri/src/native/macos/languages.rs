//! The languages set for this app alone: its own `AppleLanguages` default, which Settings >
//! General > Language writes and System Settings > Language & Region > Applications writes too.

use objc2::runtime::AnyObject;
use objc2_foundation::{NSArray, NSBundle, NSString, NSUserDefaults};

const KEY: &str = "AppleLanguages";

/// None while the app follows the system's languages.
pub fn app_languages() -> Option<Vec<String>> {
    let id = NSBundle::mainBundle().bundleIdentifier()?;
    let domain = NSUserDefaults::standardUserDefaults().persistentDomainForName(&id)?;
    let value = domain.objectForKey(&NSString::from_str(KEY))?;
    let list = value.downcast_ref::<NSArray>()?;
    Some(
        list.to_vec()
            .iter()
            .filter_map(|tag| tag.downcast_ref::<NSString>().map(NSString::to_string))
            .collect(),
    )
}

/// Takes effect from the next launch: the system reads its languages once per process.
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
