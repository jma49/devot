//! The iPhone's share sheet, which offers the Mac License Key and nothing else (docs/licensing.md,
//! Get a Mac License Key): a page's own share sheet shows in the web view as a clipped popover.
//! The key is a secret: no log line or error carries it, only codes.

use crate::deep_link::{self, Link};

/// The catalog's message around a key as long as a licence may be.
const MAX_TEXT_LEN: usize = 512 + crate::licence::MAX_LENGTH;

/// A message, and the `devot://licence?key=` link of a licence key exactly as the window builds it.
fn validate(text: &str, url: &str) -> Result<(), &'static str> {
    if text.trim().is_empty() || text.len() > MAX_TEXT_LEN || text.contains('\0') {
        return Err("E_SHARE_TEXT_INVALID");
    }
    let Ok(Link::Licence { key: Some(key), .. }) = deep_link::parse(url, deep_link::RELEASE_SCHEME)
    else {
        return Err("E_SHARE_URL_INVALID");
    };
    let key = key.as_str();
    let mut parts = key.split('.');
    let shaped = parts.next() == Some(crate::licence::LICENCE_PREFIX)
        && parts.next().is_some_and(|part| !part.is_empty())
        && parts.next().is_some_and(|part| !part.is_empty())
        && parts.next().is_none();
    let built = url
        .strip_prefix("devot://licence?key=")
        .is_some_and(|value| value == key);
    if shaped && built {
        Ok(())
    } else {
        Err("E_SHARE_URL_INVALID")
    }
}

/// Resolves once the sheet is gone; a share the user cancels is not an error.
#[tauri::command]
pub async fn phone_share(app: tauri::AppHandle, text: String, url: String) -> Result<(), String> {
    validate(&text, &url).map_err(String::from)?;
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
    use crate::licence::testing::{ID, key};

    fn link(key: &str) -> String {
        format!("devot://licence?key={key}")
    }

    fn text(key: &str) -> String {
        format!("Devot license key: {key}\n\nOpen the link on your Mac to add it in Devot.")
    }

    #[test]
    fn takes_a_licence_key_and_its_link() {
        let key = key(ID);
        assert_eq!(validate(&text(&key), &link(&key)), Ok(()));
    }

    #[test]
    fn refuses_an_empty_long_or_nul_message() {
        let url = link(&key(ID));
        assert_eq!(validate("", &url), Err("E_SHARE_TEXT_INVALID"));
        assert_eq!(validate(" \n", &url), Err("E_SHARE_TEXT_INVALID"));
        assert_eq!(validate("a\0b", &url), Err("E_SHARE_TEXT_INVALID"));
        let long = "a".repeat(MAX_TEXT_LEN + 1);
        assert_eq!(validate(&long, &url), Err("E_SHARE_TEXT_INVALID"));
        assert_eq!(validate(&"a".repeat(MAX_TEXT_LEN), &url), Ok(()));
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
            link("devot1dev.abc.def"),
            link("devot1rev.abc.def"),
            link(&"a".repeat(crate::licence::MAX_LENGTH + 1)),
        ] {
            assert_eq!(
                validate(&message, &url),
                Err("E_SHARE_URL_INVALID"),
                "{url}"
            );
        }
    }
}
