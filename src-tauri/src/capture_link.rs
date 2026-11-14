//! `devot://capture?title=…&text=…&url=…`: a link from Shortcuts, a launcher or a bookmarklet fills
//! quick capture, and the owner saves it there (Command-Return) or cancels; no link makes a note by
//! itself, so a page that opens the link over and over makes none.
//! Every field is optional, but one must hold something; each comes at most once, percent-encoded
//! (`+` is a space), and nothing else may follow. `url` must be an http or https address and ends
//! the body on a line of its own.
//! The window takes what waits here when it loads and whenever it hears [`PREFILL_EVENT`]
//! (`quick_capture_prefill_take`), so a link that opens it, or reaches it already open, is never
//! lost; a refused link is logged by its code alone, and `Debug` never shows the text.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;

use crate::commands::notes::MAX_TITLE_CHARS;

/// The query, encoded; macOS hands over far longer URLs, but a capture is a note's start.
pub(crate) const MAX_CAPTURE_URL_LEN: usize = 256 * 1024;
const MAX_SOURCE_URL_LEN: usize = 2048;
/// A selection sent from the Services menu, in bytes, as large as the longest capture link.
pub(crate) const MAX_SELECTION_LEN: usize = MAX_CAPTURE_URL_LEN;
/// Links that reached no window yet; one more is dropped.
const MAX_WAITING: usize = 4;
#[cfg(desktop)]
pub(crate) const PREFILL_EVENT: &str = "devot://quick-capture-prefill";

#[derive(Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
pub struct Prefill {
    title: String,
    body: String,
}

impl std::fmt::Debug for Prefill {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Prefill(..)")
    }
}

fn decode(value: &str) -> Result<String, &'static str> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'%' => {
                let hex = value.get(at + 1..at + 3).ok_or("E_URL_CAPTURE")?;
                out.push(u8::from_str_radix(hex, 16).map_err(|_| "E_URL_CAPTURE")?);
                at += 3;
            }
            b'+' => {
                out.push(b' ');
                at += 1;
            }
            byte => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8(out).map_err(|_| "E_URL_CAPTURE")
}

/// Line ends become `\n`; other control characters, but tabs, go.
fn plain_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect()
}

/// One line, clipped to the title limit `note_put` holds a note to.
fn one_line(title: &str) -> String {
    let flat: String = plain_text(title)
        .chars()
        .map(|c| if matches!(c, '\n' | '\t') { ' ' } else { c })
        .collect();
    flat.trim().chars().take(MAX_TITLE_CHARS).collect()
}

fn source_url(url: &str) -> Result<String, &'static str> {
    let url = url.trim();
    if url.len() > MAX_SOURCE_URL_LEN || url.chars().any(char::is_whitespace) {
        return Err("E_URL_CAPTURE_SOURCE");
    }
    let parsed = tauri::Url::parse(url).map_err(|_| "E_URL_CAPTURE_SOURCE")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("E_URL_CAPTURE_SOURCE");
    }
    Ok(url.to_owned())
}

/// The query of a capture link, after `capture?`.
pub(crate) fn parse(query: &str) -> Result<Prefill, &'static str> {
    if query.contains('#') {
        return Err("E_URL_CAPTURE");
    }
    let (mut title, mut text, mut url) = (None, None, None);
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').ok_or("E_URL_CAPTURE")?;
        let slot = match key {
            "title" => &mut title,
            "text" => &mut text,
            "url" => &mut url,
            _ => return Err("E_URL_CAPTURE"),
        };
        if slot.replace(decode(value)?).is_some() {
            return Err("E_URL_CAPTURE");
        }
    }
    let title = title.as_deref().map(one_line).unwrap_or_default();
    let text = text.as_deref().map(plain_text).unwrap_or_default();
    let text = text.trim_end();
    let url = url
        .as_deref()
        .filter(|url| !url.trim().is_empty())
        .map(source_url)
        .transpose()?;
    let body = body(text, url);
    if title.is_empty() && body.trim().is_empty() {
        return Err("E_URL_CAPTURE_EMPTY");
    }
    Ok(Prefill { title, body })
}

fn body(text: &str, url: Option<String>) -> String {
    match url {
        Some(url) if text.trim().is_empty() => url,
        Some(url) => format!("{text}\n\n{url}"),
        None => text.to_owned(),
    }
}

/// What another app sends through Services: its selected text, a URL, or both.
/// A source that is not a web address is dropped rather than refused, since apps send file URLs too.
pub(crate) fn from_selection(
    text: Option<&str>,
    url: Option<&str>,
) -> Result<Prefill, &'static str> {
    let text = text.unwrap_or_default();
    if text.len() > MAX_SELECTION_LEN {
        return Err("E_SERVICE_CAPTURE_TOO_LONG");
    }
    let mut url = url.and_then(|url| source_url(url).ok());
    let mut text = plain_text(text).trim_end().to_owned();
    if url.is_none()
        && let Ok(link) = source_url(&text)
    {
        url = Some(link);
        text.clear();
    }
    let body = body(&text, url);
    if body.trim().is_empty() {
        return Err("E_SERVICE_CAPTURE_EMPTY");
    }
    Ok(Prefill {
        title: String::new(),
        body,
    })
}

/// Captures from links the quick capture window has not taken yet.
#[derive(Default)]
pub struct Prefills(Mutex<VecDeque<Prefill>>);

impl Prefills {
    /// Whether it was kept: one past [`MAX_WAITING`] is dropped.
    pub(crate) fn offer(&self, prefill: Prefill) -> bool {
        let mut waiting = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if waiting.len() >= MAX_WAITING {
            return false;
        }
        waiting.push_back(prefill);
        true
    }

    pub(crate) fn take(&self) -> Vec<Prefill> {
        let mut waiting = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        waiting.drain(..).collect()
    }
}

/// Opens quick capture with the link's text; the window takes it once it listens.
#[cfg(desktop)]
pub(crate) fn deliver<R: tauri::Runtime>(app: &tauri::AppHandle<R>, prefill: Prefill) {
    use tauri::{Emitter, Manager};
    let Some(prefills) = app.try_state::<Prefills>() else {
        return;
    };
    if !prefills.offer(prefill) {
        log::warn!("W_CAPTURE_LINK_DROPPED");
        return;
    }
    crate::menu_bar::open_quick_capture(app);
    if app
        .emit_to(crate::menu_bar::QUICK_CAPTURE, PREFILL_EVENT, ())
        .is_err()
    {
        log::warn!("W_CAPTURE_LINK_UNSENT");
    }
}

/// Listens for the Services menu's "New Devot Note" for the rest of the process.
#[cfg(target_os = "macos")]
pub(crate) fn receive_services<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let app = app.clone();
    let listening = crate::native::macos::provide_services(Box::new(move |text, url| {
        match from_selection(text.as_deref(), url.as_deref()) {
            Ok(prefill) => deliver(&app, prefill),
            Err(code) => log::warn!("{code}"),
        }
    }));
    if !listening {
        log::warn!("W_SERVICE_CAPTURE_UNAVAILABLE");
    }
}

#[cfg(desktop)]
#[tauri::command]
pub fn quick_capture_prefill_take(
    window: tauri::WebviewWindow,
    prefills: tauri::State<'_, Prefills>,
) -> Result<Vec<Prefill>, String> {
    if window.label() != crate::menu_bar::QUICK_CAPTURE {
        return Err("E_QUICK_CAPTURE_WINDOW".into());
    }
    Ok(prefills.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prefill(title: &str, body: &str) -> Prefill {
        Prefill {
            title: title.into(),
            body: body.into(),
        }
    }

    #[test]
    fn reads_a_title_a_text_and_a_source_in_any_order() {
        assert_eq!(
            parse("title=Groceries&text=milk%0Aeggs"),
            Ok(prefill("Groceries", "milk\neggs"))
        );
        assert_eq!(
            parse("url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&text=A+quote&title=Page"),
            Ok(prefill("Page", "A quote\n\nhttps://example.com/a?b=1"))
        );
        assert_eq!(parse("text=only"), Ok(prefill("", "only")));
        assert_eq!(parse("title=only"), Ok(prefill("only", "")));
        assert_eq!(
            parse("url=http://example.com"),
            Ok(prefill("", "http://example.com"))
        );
    }

    #[test]
    fn decodes_utf_8_and_keeps_a_literal_plus_that_was_encoded() {
        assert_eq!(
            parse("title=%E2%9C%93+done&text=1%2B1"),
            Ok(prefill("\u{2713} done", "1+1"))
        );
    }

    #[test]
    fn a_title_is_one_trimmed_line_within_the_title_limit() {
        assert_eq!(
            parse("title=%20one%0D%0Atwo%09three%20"),
            Ok(prefill("one two three", ""))
        );
        let long = "t".repeat(MAX_TITLE_CHARS + 10);
        let parsed = parse(&format!("title={long}")).unwrap();
        assert_eq!(parsed.title.chars().count(), MAX_TITLE_CHARS);
    }

    #[test]
    fn text_keeps_its_lines_and_tabs_but_no_other_control_characters() {
        assert_eq!(
            parse("text=a%0D%0Ab%0Dc%09d%00e%1Bf%0A%0A"),
            Ok(prefill("", "a\nb\nc\tdef"))
        );
    }

    #[test]
    fn refuses_a_link_with_nothing_to_capture() {
        for query in ["", "title=", "title=%20&text=%0A", "text=&url="] {
            let code = if query.is_empty() {
                "E_URL_CAPTURE"
            } else {
                "E_URL_CAPTURE_EMPTY"
            };
            assert_eq!(parse(query), Err(code), "{query}");
        }
    }

    #[test]
    fn refuses_unknown_repeated_or_malformed_fields() {
        for query in [
            "title=a&title=b",
            "note=a",
            "title",
            "title=a&",
            "text=%ZZ",
            "text=%4",
            "text=%FF%FE",
            "text=a#b",
            "Title=a",
        ] {
            assert_eq!(parse(query), Err("E_URL_CAPTURE"), "{query}");
        }
    }

    #[test]
    fn refuses_a_source_that_is_not_a_web_address() {
        for url in [
            "javascript%3Aalert(1)",
            "file%3A%2F%2F%2Fetc%2Fhosts",
            "devot%3A%2F%2Ftoday",
            "https%3A%2F%2Fa.example%2F%20b",
            "not%20a%20url",
            "https%3A",
        ] {
            assert_eq!(
                parse(&format!("text=x&url={url}")),
                Err("E_URL_CAPTURE_SOURCE"),
                "{url}"
            );
        }
        let long = format!("https://example.com/{}", "a".repeat(MAX_SOURCE_URL_LEN));
        assert_eq!(parse(&format!("url={long}")), Err("E_URL_CAPTURE_SOURCE"));
    }

    #[test]
    fn a_selection_fills_the_body_and_leaves_the_title_to_the_owner() {
        assert_eq!(
            from_selection(Some("line one\r\nline two\u{0}"), None),
            Ok(prefill("", "line one\nline two"))
        );
        assert_eq!(
            from_selection(Some("A quote"), Some("https://example.com/a")),
            Ok(prefill("", "A quote\n\nhttps://example.com/a"))
        );
    }

    #[test]
    fn a_selection_that_is_one_web_address_is_the_source() {
        assert_eq!(
            from_selection(Some("  https://example.com/a?b=1\n"), None),
            Ok(prefill("", "https://example.com/a?b=1"))
        );
        assert_eq!(
            from_selection(None, Some("https://example.com")),
            Ok(prefill("", "https://example.com"))
        );
    }

    #[test]
    fn a_selection_drops_a_source_that_is_not_a_web_address() {
        assert_eq!(
            from_selection(Some("notes"), Some("file:///etc/hosts")),
            Ok(prefill("", "notes"))
        );
        assert_eq!(
            from_selection(None, Some("javascript:alert(1)")),
            Err("E_SERVICE_CAPTURE_EMPTY")
        );
    }

    #[test]
    fn refuses_an_empty_or_oversized_selection() {
        for (text, url) in [(None, None), (Some(" \n\t"), None), (Some(""), Some(" "))] {
            assert_eq!(from_selection(text, url), Err("E_SERVICE_CAPTURE_EMPTY"));
        }
        let long = "a".repeat(MAX_SELECTION_LEN + 1);
        assert_eq!(
            from_selection(Some(&long), None),
            Err("E_SERVICE_CAPTURE_TOO_LONG")
        );
        let fits = "a".repeat(MAX_SELECTION_LEN);
        assert!(from_selection(Some(&fits), None).is_ok());
    }

    #[test]
    fn never_shows_its_text_when_debugged() {
        let shown = format!("{:?}", prefill("secret title", "secret body"));
        assert!(!shown.contains("secret"), "{shown}");
    }

    #[test]
    fn holds_a_few_links_until_the_window_takes_them_all_once() {
        let prefills = Prefills::default();
        for at in 0..MAX_WAITING {
            assert!(prefills.offer(prefill(&at.to_string(), "")));
        }
        assert!(!prefills.offer(prefill("more", "")));
        let taken = prefills.take();
        assert_eq!(taken.len(), MAX_WAITING);
        assert_eq!(taken[0], prefill("0", ""));
        assert!(prefills.take().is_empty());
        assert!(prefills.offer(prefill("again", "")));
    }
}
