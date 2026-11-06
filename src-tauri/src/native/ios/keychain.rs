//! The device-only keychain item.

/// Adds a generic password item that opens after the first unlock and stays on the device (never
/// in iCloud or a backup). `SecItemAdd` refuses an item that exists, so nothing is ever replaced;
/// a failure gives its `OSStatus`. The password API cannot add without updating, hence this call.
pub fn add_device_only_password(service: &str, account: &str, secret: &[u8]) -> Result<(), i32> {
    use core_foundation::base::TCFType;
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework_sys::item::{
        kSecAttrAccessControl, kSecAttrAccount, kSecAttrService, kSecClass,
        kSecClassGenericPassword, kSecValueData,
    };
    use security_framework_sys::keychain_item::SecItemAdd;

    let access = SecAccessControl::create_with_protection(
        Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
        0,
    )
    .map_err(|error| error.code())?;
    // SAFETY: the Security framework's attribute names are CFString constants that live as long as
    // the process; the get rule retains each one for its wrapper.
    let [
        class,
        generic_password,
        service_name,
        account_name,
        access_control,
        data,
    ] = unsafe {
        [
            kSecClass,
            kSecClassGenericPassword,
            kSecAttrService,
            kSecAttrAccount,
            kSecAttrAccessControl,
            kSecValueData,
        ]
        .map(|name| CFString::wrap_under_get_rule(name))
    };
    let attributes = CFDictionary::from_CFType_pairs(&[
        (class, generic_password.into_CFType()),
        (service_name, CFString::new(service).into_CFType()),
        (account_name, CFString::new(account).into_CFType()),
        (access_control, access.into_CFType()),
        (data, CFData::from_buffer(secret).into_CFType()),
    ]);
    // SAFETY: `attributes` is a valid dictionary that outlives the call, and a null result pointer
    // asks for nothing back.
    let status = unsafe { SecItemAdd(attributes.as_concrete_TypeRef(), std::ptr::null_mut()) };
    if status == 0 { Ok(()) } else { Err(status) }
}
