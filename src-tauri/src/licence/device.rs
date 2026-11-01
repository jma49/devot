//! The random ID that names this device to the licence Worker (docs/licensing.md, Activation). It
//! is made once, kept in the keychain beside the key and never derived from the hardware: the
//! Worker learns a random string and the label the buyer sees, nothing about the machine.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use super::format::is_device_id;
use super::store::KeyStore;

pub(crate) const DEVICE_ACCOUNT: &str = "device";
const DEVICE_BYTES: usize = 16;

/// The device's ID, made and kept on first use. A stored value of another shape is replaced.
pub(crate) fn id(store: &dyn KeyStore) -> Result<String, &'static str> {
    if let Some(kept) = store.get()?
        && is_device_id(&kept)
    {
        return Ok(kept);
    }
    let mut bytes = [0u8; DEVICE_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| "E_LICENCE_DEVICE_ID")?;
    let id = URL_SAFE_NO_PAD.encode(bytes);
    store.set(&id)?;
    Ok(id)
}
