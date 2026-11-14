//! The sealed page (docs/specs/share-on-web.md): `DVS1`, a random nonce, then the page's JSON under
//! AES-256-GCM with `DVS1` as associated data. Pure, so the vectors the viewer runs check it too.

use aes_gcm::aead::AeadInOut;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use zeroize::Zeroizing;

pub const MAGIC: &[u8; 4] = b"DVS1";
pub const NONCE_BYTES: usize = 12;
pub const KEY_BYTES: usize = 32;
/// What the Worker takes (`MAX_ENVELOPE_BYTES` in share/src/app.ts).
pub const MAX_ENVELOPE_BYTES: usize = 10 * 1024 * 1024;
const TAG_BYTES: usize = 16;

#[derive(serde::Serialize)]
struct Plaintext<'a> {
    v: u8,
    title: &'a str,
    html: &'a str,
}

/// The page as the viewer reads it.
pub fn plaintext(title: &str, html: &str) -> Vec<u8> {
    serde_json::to_vec(&Plaintext { v: 1, title, html }).unwrap_or_default()
}

pub fn seal(
    plaintext: &[u8],
    key: &[u8; KEY_BYTES],
    nonce: [u8; NONCE_BYTES],
) -> Result<Vec<u8>, &'static str> {
    if MAGIC.len() + NONCE_BYTES + plaintext.len() + TAG_BYTES > MAX_ENVELOPE_BYTES {
        return Err("E_SHARE_TOO_LARGE");
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "E_SHARE_SEAL_FAILED")?;
    let header = MAGIC.len() + NONCE_BYTES;
    let mut envelope = Vec::with_capacity(header + plaintext.len() + TAG_BYTES);
    envelope.extend_from_slice(MAGIC);
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(plaintext);
    let tag = cipher
        .encrypt_inout_detached(
            &Nonce::from(nonce),
            MAGIC,
            envelope[header..].as_mut().into(),
        )
        .map_err(|_| "E_SHARE_SEAL_FAILED")?;
    envelope.extend_from_slice(&tag);
    Ok(envelope)
}

pub fn new_key() -> Result<Zeroizing<[u8; KEY_BYTES]>, &'static str> {
    let mut key = Zeroizing::new([0; KEY_BYTES]);
    getrandom::fill(key.as_mut()).map_err(|_| "E_SHARE_RANDOM_FAILED")?;
    Ok(key)
}

pub fn new_nonce() -> Result<[u8; NONCE_BYTES], &'static str> {
    let mut nonce = [0; NONCE_BYTES];
    getrandom::fill(&mut nonce).map_err(|_| "E_SHARE_RANDOM_FAILED")?;
    Ok(nonce)
}

pub fn key_text(key: &[u8; KEY_BYTES]) -> String {
    URL_SAFE_NO_PAD.encode(key)
}

pub fn key_from_text(text: &str) -> Result<Zeroizing<[u8; KEY_BYTES]>, &'static str> {
    let bytes = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(text)
            .map_err(|_| "E_SHARE_KEY_INVALID")?,
    );
    let mut key = Zeroizing::new([0; KEY_BYTES]);
    if bytes.len() != KEY_BYTES {
        return Err("E_SHARE_KEY_INVALID");
    }
    key.copy_from_slice(&bytes);
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Vectors {
        cases: Vec<Vector>,
    }

    #[derive(serde::Deserialize)]
    struct Vector {
        name: String,
        key: String,
        nonce: String,
        plaintext: String,
        envelope: String,
    }

    fn vectors() -> Vec<Vector> {
        let text = include_str!("../../../tests/fixtures/share-vectors.json");
        serde_json::from_str::<Vectors>(text).unwrap().cases
    }

    #[test]
    fn seals_each_vector_to_its_envelope() {
        for vector in vectors() {
            let key = key_from_text(&vector.key).unwrap();
            let nonce: [u8; NONCE_BYTES] = URL_SAFE_NO_PAD
                .decode(&vector.nonce)
                .unwrap()
                .try_into()
                .unwrap();
            let sealed = seal(vector.plaintext.as_bytes(), &key, nonce).unwrap();
            assert_eq!(
                URL_SAFE_NO_PAD.encode(sealed),
                vector.envelope,
                "{}",
                vector.name
            );
        }
    }

    #[test]
    fn writes_the_plaintext_the_viewer_reads() {
        for vector in vectors() {
            let page: serde_json::Value = serde_json::from_str(&vector.plaintext).unwrap();
            let written = plaintext(
                page["title"].as_str().unwrap(),
                page["html"].as_str().unwrap(),
            );
            assert_eq!(
                String::from_utf8(written).unwrap(),
                vector.plaintext,
                "{}",
                vector.name
            );
        }
    }

    #[test]
    fn makes_a_new_key_and_nonce_each_time_and_reads_a_key_back() {
        let (a, b) = (new_key().unwrap(), new_key().unwrap());
        assert_ne!(*a, *b);
        assert_ne!(new_nonce().unwrap(), new_nonce().unwrap());
        let text = key_text(&a);
        assert_eq!(text.len(), 43);
        assert_eq!(*key_from_text(&text).unwrap(), *a);
        for bad in [
            "",
            "short",
            &text[1..],
            &format!("{text}A"),
            "!".repeat(43).as_str(),
        ] {
            assert_eq!(key_from_text(bad).err(), Some("E_SHARE_KEY_INVALID"));
        }
    }

    #[test]
    fn refuses_a_page_the_worker_would_refuse() {
        let key = new_key().unwrap();
        let fits = vec![b'x'; MAX_ENVELOPE_BYTES - 4 - NONCE_BYTES - TAG_BYTES];
        assert_eq!(
            seal(&fits, &key, [0; NONCE_BYTES]).unwrap().len(),
            MAX_ENVELOPE_BYTES
        );
        let over = vec![b'x'; fits.len() + 1];
        assert_eq!(
            seal(&over, &key, [0; NONCE_BYTES]).err(),
            Some("E_SHARE_TOO_LARGE")
        );
    }
}
