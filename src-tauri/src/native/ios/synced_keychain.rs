use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};
use security_framework_sys::access_control::kSecAttrAccessibleAfterFirstUnlock;
use security_framework_sys::item::{
    kSecAttrAccessGroup, kSecAttrAccount, kSecAttrService, kSecAttrSynchronizable, kSecClass,
    kSecClassGenericPassword, kSecMatchLimit, kSecReturnData, kSecValueData,
};
use security_framework_sys::keychain_item::{
    SecItemAdd, SecItemCopyMatching, SecItemDelete, SecItemUpdate,
};

use crate::native::guarded;

// The crate declares the first only on macOS builds that ask for 10.15, and not the others.
#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    static kSecUseDataProtectionKeychain: CFStringRef;
    static kSecAttrAccessible: CFStringRef;
    static kSecMatchLimitOne: CFStringRef;
}

use crate::keychain::{DUPLICATE_ITEM as DUPLICATE, ITEM_NOT_FOUND as NOT_FOUND};
/// `errSecDecode`: the item's data was not data.
const DECODE: i32 = -26275;
/// `errSecInternalComponent`: the call itself failed.
const INTERNAL: i32 = -2070;

fn constant(name: CFStringRef) -> CFString {
    // SAFETY: every name passed here is one of the Security framework's CFString constants, which
    // live as long as the process; the get rule retains it for its wrapper.
    unsafe { CFString::wrap_under_get_rule(name) }
}

/// The attributes that name the item: class, service, account, group, synchronizable, and the
/// data protection keychain (the only one on iOS, and on macOS the one that syncs).
fn query(service: &str, account: &str, group: &str) -> Vec<(CFString, CFType)> {
    // SAFETY: reads of the Security framework's constant names, which never change.
    let (class, generic, service_key, account_key, group_key, synchronizable, protected) = unsafe {
        (
            kSecClass,
            kSecClassGenericPassword,
            kSecAttrService,
            kSecAttrAccount,
            kSecAttrAccessGroup,
            kSecAttrSynchronizable,
            kSecUseDataProtectionKeychain,
        )
    };
    vec![
        (constant(class), constant(generic).into_CFType()),
        (constant(service_key), CFString::new(service).into_CFType()),
        (constant(account_key), CFString::new(account).into_CFType()),
        (constant(group_key), CFString::new(group).into_CFType()),
        (
            constant(synchronizable),
            CFBoolean::true_value().into_CFType(),
        ),
        (constant(protected), CFBoolean::true_value().into_CFType()),
    ]
}

fn call(work: impl FnOnce() -> i32) -> i32 {
    guarded("W_SYNC_HANDOVER_NATIVE", || Some(work())).unwrap_or(INTERNAL)
}

pub(crate) fn read(service: &str, account: &str, group: &str) -> Result<Option<Vec<u8>>, i32> {
    let mut pairs = query(service, account, group);
    // SAFETY: as in `query`.
    let (return_data, limit, one) = unsafe { (kSecReturnData, kSecMatchLimit, kSecMatchLimitOne) };
    pairs.push((constant(return_data), CFBoolean::true_value().into_CFType()));
    pairs.push((constant(limit), constant(one).into_CFType()));
    let query = CFDictionary::from_CFType_pairs(&pairs);
    let mut result: CFTypeRef = std::ptr::null();
    let status = call(|| {
        // SAFETY: `query` is a valid dictionary that outlives the call; `result` is written only
        // on success, with an object this code then owns under the create rule.
        unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut result) }
    });
    match status {
        0 if !result.is_null() => {
            // SAFETY: a non-null result of a successful copy, owned by this code.
            let value = unsafe { CFType::wrap_under_create_rule(result) };
            value
                .downcast::<CFData>()
                .map(|data| Some(data.bytes().to_vec()))
                .ok_or(DECODE)
        }
        0 => Err(DECODE),
        NOT_FOUND => Ok(None),
        status => Err(status),
    }
}

/// `false` when the item exists, which stays as it is.
pub(crate) fn add(service: &str, account: &str, group: &str, data: &[u8]) -> Result<bool, i32> {
    let mut pairs = query(service, account, group);
    // SAFETY: as in `query`.
    let (accessible, after_first_unlock, value) = unsafe {
        (
            kSecAttrAccessible,
            kSecAttrAccessibleAfterFirstUnlock,
            kSecValueData,
        )
    };
    pairs.push((
        constant(accessible),
        constant(after_first_unlock).into_CFType(),
    ));
    pairs.push((constant(value), CFData::from_buffer(data).into_CFType()));
    let attributes = CFDictionary::from_CFType_pairs(&pairs);
    let status = call(|| {
        // SAFETY: `attributes` is a valid dictionary that outlives the call, and a null result
        // pointer asks for nothing back.
        unsafe { SecItemAdd(attributes.as_concrete_TypeRef(), std::ptr::null_mut()) }
    });
    match status {
        0 => Ok(true),
        DUPLICATE => Ok(false),
        status => Err(status),
    }
}

pub(crate) fn update(service: &str, account: &str, group: &str, data: &[u8]) -> Result<(), i32> {
    let query = CFDictionary::from_CFType_pairs(&query(service, account, group));
    // SAFETY: as in `query`.
    let value = unsafe { kSecValueData };
    let changes = CFDictionary::from_CFType_pairs(&[(
        constant(value),
        CFData::from_buffer(data).into_CFType(),
    )]);
    let status = call(|| {
        // SAFETY: both are valid dictionaries that outlive the call.
        unsafe { SecItemUpdate(query.as_concrete_TypeRef(), changes.as_concrete_TypeRef()) }
    });
    if status == 0 { Ok(()) } else { Err(status) }
}

/// `false` when there was no item.
pub(crate) fn delete(service: &str, account: &str, group: &str) -> Result<bool, i32> {
    let query = CFDictionary::from_CFType_pairs(&query(service, account, group));
    let status = call(|| {
        // SAFETY: a valid dictionary that outlives the call.
        unsafe { SecItemDelete(query.as_concrete_TypeRef()) }
    });
    match status {
        0 => Ok(true),
        NOT_FOUND => Ok(false),
        status => Err(status),
    }
}
