//! Licence keys and the revocation list, checked exactly as docs/licensing.md (Formats) says;
//! `verifyLicence` and `verifyRevocations` in licence/src/format.ts are the reference.

use std::collections::BTreeSet;
use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::{Map, Value};

pub(crate) const LICENCE_PREFIX: &str = "devot1";
pub(crate) const ACTIVATION_PREFIX: &str = "devot1dev";
pub(crate) const REVOCATIONS_PREFIX: &str = "devot1rev";
pub(crate) const PLAN: &str = "pro";
pub(crate) const MAX_LENGTH: usize = 1024;
pub(crate) const MAX_REVOCATIONS_LENGTH: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VerifyError {
    Malformed,
    UnknownKid,
    Signature,
}

impl VerifyError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Malformed => "E_LICENCE_MALFORMED",
            Self::UnknownKid => "E_LICENCE_UNKNOWN_KID",
            Self::Signature => "E_LICENCE_SIGNATURE",
        }
    }
}

/// A verified licence. `Debug` shows the licence ID alone: the licensee is personal data.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Payload {
    pub id: String,
    pub kid: String,
    pub licensee: String,
    pub issued_at: String,
}

impl fmt::Debug for Payload {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Payload")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

/// A device's seat on a licence, signed by the Worker and checked offline (docs/licensing.md,
/// Activation). `Debug` shows the ids alone.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Activation {
    pub id: String,
    pub device: String,
    pub issued_at: String,
    pub expires_at: String,
}

impl fmt::Debug for Activation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Activation")
            .field("id", &self.id)
            .field("device", &self.device)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Revocations {
    pub kid: String,
    pub issued_at: String,
    pub ids: BTreeSet<String>,
}

/// The public keys a build trusts, by `kid`.
pub(crate) trait KeyRing {
    fn key(&self, kid: &str) -> Option<&VerifyingKey>;
}

pub(crate) fn verify_licence(key: &str, keys: &dyn KeyRing) -> Result<Payload, VerifyError> {
    verify_envelope(key, LICENCE_PREFIX, MAX_LENGTH, keys, licence_payload)
}

pub(crate) fn verify_activation(
    lease: &str,
    keys: &dyn KeyRing,
) -> Result<Activation, VerifyError> {
    verify_envelope(
        lease,
        ACTIVATION_PREFIX,
        MAX_LENGTH,
        keys,
        activation_payload,
    )
}

pub(crate) fn verify_revocations(
    list: &str,
    keys: &dyn KeyRing,
) -> Result<Revocations, VerifyError> {
    verify_envelope(
        list,
        REVOCATIONS_PREFIX,
        MAX_REVOCATIONS_LENGTH,
        keys,
        revocations_payload,
    )
}

/// Reads a payload's fields, and its `kid`, from the JSON object.
type Reader<T> = fn(&Map<String, Value>) -> Option<(T, String)>;

fn verify_envelope<T>(
    text: &str,
    prefix: &str,
    max_length: usize,
    keys: &dyn KeyRing,
    read: Reader<T>,
) -> Result<T, VerifyError> {
    use VerifyError::Malformed;
    // Bytes, not characters: past the cap only a non-ASCII text could still fit, and that is
    // malformed either way.
    if text.len() > max_length {
        return Err(Malformed);
    }
    let mut parts = text.split('.');
    let (Some(head), Some(body), Some(tail), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(Malformed);
    };
    if head != prefix {
        return Err(Malformed);
    }
    let bytes = from_base64url(body).ok_or(Malformed)?;
    let signature: [u8; 64] = from_base64url(tail)
        .and_then(|s| s.try_into().ok())
        .ok_or(Malformed)?;
    let json = std::str::from_utf8(&bytes).map_err(|_| Malformed)?;
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(json) else {
        return Err(Malformed);
    };
    let (payload, kid) = read(&object).ok_or(Malformed)?;
    let public = keys.key(&kid).ok_or(VerifyError::UnknownKid)?;
    let signed = &text[..head.len() + 1 + body.len()];
    public
        .verify_strict(signed.as_bytes(), &Signature::from_bytes(&signature))
        .map(|()| payload)
        .map_err(|_| VerifyError::Signature)
}

/// Canonical base64url without padding: no other alphabet, no padding, no stray trailing bits.
pub(crate) fn from_base64url(text: &str) -> Option<Vec<u8>> {
    if text.is_empty() {
        return None;
    }
    URL_SAFE_NO_PAD.decode(text).ok()
}

fn is_licence_id(text: &str) -> bool {
    text.len() == 22
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn shaped(text: &str, shape: &[u8]) -> bool {
    text.len() == shape.len()
        && text.bytes().zip(shape).all(|(b, s)| match s {
            b'9' => b.is_ascii_digit(),
            other => b == *other,
        })
}

fn is_instant(text: &str) -> bool {
    shaped(text, b"9999-99-99T99:99:99Z")
}

pub(crate) fn is_device_id(text: &str) -> bool {
    is_licence_id(text)
}

fn text<'a>(object: &'a Map<String, Value>, field: &str) -> Option<&'a str> {
    object.get(field).and_then(Value::as_str)
}

fn licence_payload(object: &Map<String, Value>) -> Option<(Payload, String)> {
    let id = text(object, "id").filter(|id| is_licence_id(id))?;
    let kid = text(object, "kid")?;
    text(object, "plan").filter(|plan| *plan == PLAN)?;
    let licensee = text(object, "licensee").filter(|l| !l.is_empty())?;
    let issued_at = text(object, "issuedAt").filter(|t| is_instant(t))?;
    Some((
        Payload {
            id: id.to_owned(),
            kid: kid.to_owned(),
            licensee: licensee.to_owned(),
            issued_at: issued_at.to_owned(),
        },
        kid.to_owned(),
    ))
}

fn revocations_payload(object: &Map<String, Value>) -> Option<(Revocations, String)> {
    let kid = text(object, "kid")?;
    let issued_at = text(object, "issuedAt").filter(|t| is_instant(t))?;
    let ids = object
        .get("ids")?
        .as_array()?
        .iter()
        .map(|id| {
            id.as_str()
                .filter(|id| is_licence_id(id))
                .map(str::to_owned)
        })
        .collect::<Option<BTreeSet<_>>>()?;
    Some((
        Revocations {
            kid: kid.to_owned(),
            issued_at: issued_at.to_owned(),
            ids,
        },
        kid.to_owned(),
    ))
}

fn activation_payload(object: &Map<String, Value>) -> Option<(Activation, String)> {
    let id = text(object, "id").filter(|id| is_licence_id(id))?;
    let device = text(object, "device").filter(|d| is_device_id(d))?;
    let kid = text(object, "kid")?;
    let issued_at = text(object, "issuedAt").filter(|t| is_instant(t))?;
    let expires_at = text(object, "expiresAt").filter(|t| is_instant(t))?;
    Some((
        Activation {
            id: id.to_owned(),
            device: device.to_owned(),
            issued_at: issued_at.to_owned(),
            expires_at: expires_at.to_owned(),
        },
        kid.to_owned(),
    ))
}
