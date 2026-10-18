//! What the paste chooser fetches about a pasted URL, only once the user
//! highlights or picks a format that needs it: a page's title, and the file
//! a GitHub blob link points to (unauthenticated, so public repositories
//! only). Requests go through `net` (https only, capped); nothing runs a
//! page's scripts, so a title a page sets from script is missed. Errors are
//! codes, never URLs or titles.

use crate::net::{self, Get};
use std::time::Duration;
use tauri::Url;

/// One fetch, redirects included.
const TIMEOUT: Duration = Duration::from_secs(10);
/// The start of a page read for its title: `<head>` comes first.
const MAX_PAGE_BYTES: usize = 512 * 1024;
/// The largest file a snippet takes.
const MAX_SNIPPET_BYTES: usize = 1024 * 1024;
/// The longest title returned, in characters.
const MAX_TITLE_CHARS: usize = 300;

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "E_LINK_FAILED".to_string())?
        .map_err(String::from)
}

/// The title of the web page at `url` (https only); None when it has none.
#[tauri::command]
pub async fn link_title(url: String) -> Result<Option<String>, String> {
    let url = net::https_url(&url).map_err(String::from)?;
    blocking(move || fetch_title(&url)).await
}

/// The text of the file a `https://github.com/{owner}/{repo}/blob/{ref}/{path}`
/// link points to, whole (the renderer slices the lines).
#[tauri::command]
pub async fn github_snippet(url: String) -> Result<String, String> {
    let api = github_contents_url(&url).map_err(String::from)?;
    blocking(move || fetch_snippet(&api)).await
}

fn fetch_title(url: &Url) -> Result<Option<String>, &'static str> {
    let page = net::get(&Get {
        url,
        accept: "text/html,application/xhtml+xml;q=0.9",
        headers: &[],
        timeout: TIMEOUT,
        max_bytes: MAX_PAGE_BYTES,
    })?;
    if !(200..300).contains(&page.status) {
        return Err("E_LINK_HTTP");
    }
    if !is_html(page.content_type.as_deref()) {
        return Err("E_LINK_NOT_HTML");
    }
    Ok(utf8_text(&page.body).and_then(page_title))
}

fn fetch_snippet(api: &Url) -> Result<String, &'static str> {
    let file = net::get(&Get {
        url: api,
        accept: "application/vnd.github.raw+json",
        headers: &[("X-GitHub-Api-Version", "2022-11-28")],
        timeout: TIMEOUT,
        max_bytes: MAX_SNIPPET_BYTES,
    })?;
    match file.status {
        200..=299 => {}
        404 => return Err("E_GITHUB_NOT_FOUND"),
        403 | 429 => return Err("E_GITHUB_RATE_LIMITED"),
        _ => return Err("E_LINK_HTTP"),
    }
    if file.truncated {
        return Err("E_LINK_TOO_LARGE");
    }
    if file.body.contains(&0) {
        return Err("E_GITHUB_BINARY");
    }
    String::from_utf8(file.body).map_err(|_| "E_GITHUB_BINARY")
}

/// A page's text when it is UTF-8 (its last character may be cut off by the
/// byte cap); None for another encoding, whose title would come out garbled.
fn utf8_text(bytes: &[u8]) -> Option<&str> {
    match std::str::from_utf8(bytes) {
        Ok(text) => Some(text),
        // Only an incomplete character at the very end: the cap cut it.
        Err(e) if e.error_len().is_none() => std::str::from_utf8(&bytes[..e.valid_up_to()]).ok(),
        Err(_) => None,
    }
}

/// Whether a `Content-Type` is an HTML page.
fn is_html(content_type: Option<&str>) -> bool {
    content_type.is_some_and(|t| {
        let essence = t.split(';').next().unwrap_or("").trim();
        essence == "text/html" || essence == "application/xhtml+xml"
    })
}

/// A GitHub owner, repository or ref: one path segment of plain characters.
fn plain_segment(segment: &str, max: usize) -> bool {
    !segment.is_empty()
        && segment.len() <= max
        && segment != "."
        && segment != ".."
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// The contents API URL for a github.com blob link (the file, raw).
fn github_contents_url(url: &str) -> Result<Url, &'static str> {
    const INVALID: &str = "E_GITHUB_URL_INVALID";
    let parsed = net::https_url(url)?;
    if parsed.host_str() != Some("github.com") || parsed.port().is_some() {
        return Err(INVALID);
    }
    let segments: Vec<&str> = parsed.path_segments().ok_or(INVALID)?.collect();
    let [owner, repo, blob, git_ref, path @ ..] = segments.as_slice() else {
        return Err(INVALID);
    };
    if *blob != "blob"
        || !plain_segment(owner, 100)
        || !plain_segment(repo, 100)
        || !plain_segment(git_ref, 255)
        || path.is_empty()
        || path.iter().any(|s| {
            // An encoded `/` or `\` would reach another API path once decoded.
            let lower = s.to_ascii_lowercase();
            s.is_empty()
                || *s == "."
                || *s == ".."
                || lower.contains("%2f")
                || lower.contains("%5c")
                || lower.contains("%2e")
        })
    {
        return Err(INVALID);
    }
    // The path's segments are already percent-encoded by the parser.
    Url::parse(&format!(
        "https://api.github.com/repos/{owner}/{repo}/contents/{}?ref={git_ref}",
        path.join("/")
    ))
    .map_err(|_| INVALID)
}

/// The start of the tag `<name` (followed by `>`, a space or `/`) in `lower`
/// at or after `from`.
fn find_tag(lower: &str, name: &str, from: usize) -> Option<usize> {
    let open = format!("<{name}");
    let mut at = from;
    while let Some(found) = lower.get(at..)?.find(&open) {
        let start = at + found;
        let next = lower.as_bytes().get(start + open.len()).copied();
        if matches!(next, Some(b'>' | b'/') | None) || next.is_some_and(|b| b.is_ascii_whitespace())
        {
            return Some(start);
        }
        at = start + open.len();
    }
    None
}

/// A page's title: its `<title>`, else its `og:title`; entities decoded,
/// white space collapsed, at most MAX_TITLE_CHARS. None when both are empty.
fn page_title(html: &str) -> Option<String> {
    // ASCII lower-casing keeps every byte offset.
    let lower = html.to_ascii_lowercase();
    let from_title = find_tag(&lower, "title", 0).and_then(|start| {
        let open_end = start + lower[start..].find('>')? + 1;
        let close = lower[open_end..]
            .find("</title")
            .map_or(lower.len(), |i| open_end + i);
        tidy(&html[open_end..close])
    });
    from_title.or_else(|| og_title(html, &lower))
}

/// The `content` of `<meta property="og:title">` (or `name=`).
fn og_title(html: &str, lower: &str) -> Option<String> {
    let mut at = 0;
    while let Some(start) = find_tag(lower, "meta", at) {
        let end = lower[start..].find('>').map_or(lower.len(), |i| start + i);
        let attrs = attributes(&html[start + 5..end]);
        let is_og = attrs.iter().any(|(name, value)| {
            (name == "property" || name == "name") && value.eq_ignore_ascii_case("og:title")
        });
        if is_og
            && let Some((_, content)) = attrs.iter().find(|(name, _)| name == "content")
            && let Some(title) = tidy(content)
        {
            return Some(title);
        }
        at = end;
    }
    None
}

/// A tag's `name=value` pairs (names lower-cased); values quoted or bare.
fn attributes(tag: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    let mut rest = tag;
    loop {
        rest = rest.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == '/');
        let name_len = rest
            .find(|c: char| c.is_ascii_whitespace() || c == '=' || c == '/')
            .unwrap_or(rest.len());
        if name_len == 0 {
            return pairs;
        }
        let name = rest[..name_len].to_ascii_lowercase();
        rest = rest[name_len..].trim_start();
        let Some(after) = rest.strip_prefix('=') else {
            pairs.push((name, String::new()));
            continue;
        };
        let after = after.trim_start();
        let (value, tail) = match after.chars().next() {
            Some(q @ ('"' | '\'')) => {
                let inner = &after[1..];
                let close = inner.find(q).unwrap_or(inner.len());
                (&inner[..close], inner.get(close + 1..).unwrap_or(""))
            }
            _ => {
                let end = after
                    .find(|c: char| c.is_ascii_whitespace())
                    .unwrap_or(after.len());
                (&after[..end], &after[end..])
            }
        };
        pairs.push((name, value.to_string()));
        rest = tail;
    }
}

/// Text with entities decoded and white space collapsed, cut to
/// MAX_TITLE_CHARS; None when nothing is left.
fn tidy(raw: &str) -> Option<String> {
    let decoded = decode_entities(raw);
    let collapsed = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    let title: String = collapsed.chars().take(MAX_TITLE_CHARS).collect();
    let title = title.trim_end().to_string();
    (!title.is_empty()).then_some(title)
}

fn named_entity(name: &str) -> Option<char> {
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        "ndash" => '\u{2013}',
        "mdash" => '\u{2014}',
        "hellip" => '\u{2026}',
        "middot" => '\u{00B7}',
        "bull" => '\u{2022}',
        "lsquo" => '\u{2018}',
        "rsquo" => '\u{2019}',
        "ldquo" => '\u{201C}',
        "rdquo" => '\u{201D}',
        "laquo" => '\u{00AB}',
        "raquo" => '\u{00BB}',
        "copy" => '\u{00A9}',
        "reg" => '\u{00AE}',
        "trade" => '\u{2122}',
        _ => return None,
    })
}

/// Decodes `&name;`, `&#NN;` and `&#xHH;`; anything else stays as it is.
fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp + 1..];
        let decoded = tail.find(';').filter(|&semi| semi <= 10).and_then(|semi| {
            let name = &tail[..semi];
            let ch = if let Some(num) = name.strip_prefix('#') {
                let code = match num.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => num.parse::<u32>().ok(),
                };
                code.and_then(char::from_u32).filter(|c| *c != '\0')
            } else {
                named_entity(name)
            };
            ch.map(|c| (c, semi))
        });
        match decoded {
            Some((c, semi)) => {
                out.push(c);
                rest = &tail[semi + 1..];
            }
            None => {
                out.push('&');
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_title_element() {
        assert_eq!(
            page_title("<html><head><TITLE>Hello\n   world </TITLE></head></html>").as_deref(),
            Some("Hello world")
        );
        assert_eq!(
            page_title(r#"<title data-x="1">A &amp; B &#8212; &#x41;&lt;&gt; &bogus; &</title>"#)
                .as_deref(),
            Some("A & B \u{2014} A<> &bogus; &")
        );
        // `<titles>` is another tag; an unclosed title runs to the end.
        assert_eq!(
            page_title("<titles>no</titles><title>yes").as_deref(),
            Some("yes")
        );
    }

    #[test]
    fn falls_back_to_og_title() {
        let html = r#"<head><title>  </title>
            <meta name="x" content="no">
            <meta content='From &quot;OG&quot;' property="og:title" /></head>"#;
        assert_eq!(page_title(html).as_deref(), Some("From \"OG\""));
        assert_eq!(
            page_title("<meta property=og:title content=Bare>").as_deref(),
            Some("Bare")
        );
        assert_eq!(page_title("<p>no title</p>"), None);
    }

    #[test]
    fn caps_the_title() {
        let html = format!("<title>{}</title>", "\u{00E9}".repeat(400));
        let title = page_title(&html).unwrap();
        assert_eq!(title.chars().count(), MAX_TITLE_CHARS);
    }

    #[test]
    fn reads_utf8_pages_only() {
        assert_eq!(utf8_text("caf\u{e9}".as_bytes()), Some("caf\u{e9}"));
        // Cut inside the last character by the byte cap.
        let cut = &"a\u{e9}".as_bytes()[..2];
        assert_eq!(utf8_text(cut), Some("a"));
        // windows-1252 or Latin-1 bytes.
        assert_eq!(utf8_text(b"caf\xe9 au lait"), None);
    }

    #[test]
    fn knows_html_content_types() {
        assert!(is_html(Some("text/html")));
        assert!(is_html(Some("text/html; charset=utf-8")));
        assert!(is_html(Some("application/xhtml+xml")));
        assert!(!is_html(Some("application/json")));
        assert!(!is_html(Some("text/htmlx")));
        assert!(!is_html(None));
    }

    #[test]
    fn maps_blob_links_to_the_contents_api() {
        let api =
            github_contents_url("https://github.com/o/r-1/blob/main/src/a%20b.ts#L5-L9").unwrap();
        assert_eq!(
            api.as_str(),
            "https://api.github.com/repos/o/r-1/contents/src/a%20b.ts?ref=main"
        );
        let sha = "0123456789abcdef0123456789abcdef01234567";
        let api = github_contents_url(&format!("https://github.com/o/r/blob/{sha}/a.rs")).unwrap();
        assert_eq!(api.query(), Some(format!("ref={sha}").as_str()));
    }

    #[test]
    fn refuses_other_links() {
        for url in [
            "http://github.com/o/r/blob/main/a.ts",
            "https://gitlab.com/o/r/blob/main/a.ts",
            "https://github.com:444/o/r/blob/main/a.ts",
            "https://github.com/o/r/tree/main/src",
            "https://github.com/o/r/blob/main",
            "https://github.com/o/r/blob/main/",
            "https://github.com/o/r/blob/ma%20in/a.ts",
            "https://github.com/o/r/blob/main/a/../../../x",
            "https://github.com/o?x/r/blob/main/a.ts",
            "https://user@github.com/o/r/blob/main/a.ts",
            "https://github.com/o/r/blob/main/a%2F..%2F..%2Fx",
            "https://github.com/o/r/blob/main/a%5Cb",
            "https://github.com/o/r/blob/main/%2e%2e/x",
        ] {
            assert!(github_contents_url(url).is_err(), "{url}");
        }
    }
}
