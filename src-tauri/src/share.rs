//! The iPhone's share sheet, which offers the Mac License Key and nothing else (docs/licensing.md,
//! Get a Mac License Key): a page's own share sheet shows in the web view as a clipped popover.
//! The key is a secret: no log line or error carries it, only codes.

use std::sync::Arc;

use crate::deep_link::{self, Link};
use crate::licence::Licence;

/// The catalog's message around a key as long as a licence may be.
const MAX_TEXT_LEN: usize = 512 + crate::licence::MAX_LENGTH;

/// A message that holds a licence key this build trusts, and the key's link exactly as the window
/// builds it.
fn validate(text: &str, url: &str, licence: &Licence) -> Result<(), &'static str> {
    const TEXT_INVALID: &str = "E_SHARE_TEXT_INVALID";
    const URL_INVALID: &str = "E_SHARE_URL_INVALID";
    if text.trim().is_empty() || text.len() > MAX_TEXT_LEN || text.contains('\0') {
        return Err(TEXT_INVALID);
    }
    let Ok(Link::Licence { key: Some(key), .. }) = deep_link::parse(url, deep_link::RELEASE_SCHEME)
    else {
        return Err(URL_INVALID);
    };
    let key = key.as_str();
    let prefix = format!("{}://licence?key=", deep_link::RELEASE_SCHEME);
    if url.strip_prefix(&prefix) != Some(key) || !licence.signed(key) {
        return Err(URL_INVALID);
    }
    if !text.contains(key) {
        return Err(TEXT_INVALID);
    }
    Ok(())
}

/// Resolves once the sheet is gone; a share the user cancels is not an error.
#[tauri::command]
pub async fn phone_share(
    app: tauri::AppHandle,
    licence: tauri::State<'_, Arc<Licence>>,
    text: String,
    url: String,
) -> Result<(), String> {
    validate(&text, &url, &licence).map_err(String::from)?;
    present(app, text, url).await.map_err(String::from)
}

#[cfg(target_os = "ios")]
async fn present(app: tauri::AppHandle, text: String, url: String) -> Result<(), &'static str> {
    let (reply, answer) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        crate::native::ios::share(&text, &url, move |completed| {
            let _ = reply.send(completed);
        });
    })
    .map_err(|_| "E_NATIVE_MAIN_THREAD_UNAVAILABLE")?;
    // UIKit drops the handler uncalled when nothing was presented.
    match answer.await {
        Ok(true) => log::info!("I_SHARE_DONE"),
        Ok(false) => log::info!("I_SHARE_CANCELLED"),
        Err(_) => {
            log::warn!("W_SHARE_FAILED");
            return Err("E_SHARE_FAILED");
        }
    }
    Ok(())
}

#[cfg(not(target_os = "ios"))]
async fn present(app: tauri::AppHandle, text: String, url: String) -> Result<(), &'static str> {
    let _ = (app, text, url);
    Err("E_SHARE_UNSUPPORTED")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::licence::testing::{self, ID, key, licence_json, sign};

    fn link(key: &str) -> String {
        format!("devot://licence?key={key}")
    }

    fn text(key: &str) -> String {
        format!("Devot license key: {key}\n\nOpen the link on your Mac to add it in Devot.")
    }

    fn check(text: &str, url: &str) -> Result<(), &'static str> {
        let dir = tempfile::tempdir().expect("temp dir");
        validate(text, url, &testing::licence(dir.path(), true))
    }

    #[test]
    fn takes_a_licence_key_and_its_link() {
        let key = key(ID);
        assert_eq!(check(&text(&key), &link(&key)), Ok(()));
    }

    #[test]
    fn refuses_an_empty_long_or_nul_message() {
        let key = key(ID);
        let url = link(&key);
        assert_eq!(check("", &url), Err("E_SHARE_TEXT_INVALID"));
        assert_eq!(check(" \n", &url), Err("E_SHARE_TEXT_INVALID"));
        assert_eq!(
            check(&format!("{key}\0"), &url),
            Err("E_SHARE_TEXT_INVALID")
        );
        let padded = |len: usize| format!("{key}{}", "a".repeat(len - key.len()));
        assert_eq!(
            check(&padded(MAX_TEXT_LEN + 1), &url),
            Err("E_SHARE_TEXT_INVALID")
        );
        assert_eq!(check(&padded(MAX_TEXT_LEN), &url), Ok(()));
    }

    #[test]
    fn refuses_a_message_without_the_key() {
        let key = key(ID);
        let other = testing::key("aaaaaaaaaaaaaaaaaaaaaa");
        for message in [
            text(&other),
            "Devot license key".to_owned(),
            text(&key[..key.len() - 1]),
        ] {
            assert_eq!(check(&message, &link(&key)), Err("E_SHARE_TEXT_INVALID"));
        }
    }

    #[test]
    fn refuses_a_well_shaped_key_that_is_not_signed() {
        let key = key(ID);
        let (body, _) = key.rsplit_once('.').expect("signature");
        let forged = format!("{body}.{}", "A".repeat(86));
        let mut untrusted = licence_json(ID);
        untrusted["kid"] = "unknown".into();
        for unsigned in [
            forged,
            sign("devot1", &untrusted),
            sign("devot1dev", &licence_json(ID)),
        ] {
            assert_eq!(
                check(&text(&unsigned), &link(&unsigned)),
                Err("E_SHARE_URL_INVALID")
            );
        }
    }

    #[test]
    fn refuses_any_link_but_a_licence_link_built_from_a_key() {
        let key = key(ID);
        let message = text(&key);
        let encoded: String = key.bytes().map(|byte| format!("%{byte:02X}")).collect();
        for url in [
            String::new(),
            format!("https://devot.online/licence?key={key}"),
            format!("devot-dev://licence?key={key}"),
            format!("devot://note/{key}"),
            "devot://today".to_owned(),
            link(""),
            link(&encoded),
            format!("{}&x=1", link(&key)),
            format!("{}#x", link(&key)),
            link("devot1.only-one-part"),
            link("devot1..sig"),
            link("devot1.a.b.c"),
            link(&"a".repeat(crate::licence::MAX_LENGTH + 1)),
        ] {
            assert_eq!(check(&message, &url), Err("E_SHARE_URL_INVALID"), "{url}");
        }
    }
}
