//! `devot-plugin://localhost/<id>/…` (ADR 0005): an enabled plugin's container page, its page and its files, each under a policy
//! of its own. The pages and Devot's scripts for them are in `src-tauri/plugin-frame/`, which the UI tests serve the same way.

use super::{Plugins, manifest};
use std::sync::Arc;
use tauri::http::{Response, StatusCode};
use tauri::{AppHandle, Manager};

pub const SCHEME: &str = "devot-plugin";
pub const ORIGIN: &str = "devot-plugin://localhost/";

const CONTAINER_HTML: &str = include_str!("../../plugin-frame/container.html");
const CONTAINER_CSP: &str = include_str!("../../plugin-frame/container.csp");
const CONTAINER_JS: &str = include_str!("../../plugin-frame/container.js");
const CONTAINER_CSS: &str = include_str!("../../plugin-frame/container.css");
const FRAME_HTML: &str = include_str!("../../plugin-frame/frame.html");
const FRAME_CSP: &str = include_str!("../../plugin-frame/frame.csp");
const RUNTIME_JS: &str = include_str!("../../plugin-frame/runtime.js");
/// Plugin files are never pages.
const FILE_CSP: &str = "default-src 'none'";

#[derive(Debug, PartialEq, Eq)]
pub struct Served {
    pub status: StatusCode,
    pub mime: &'static str,
    pub csp: String,
    pub body: Vec<u8>,
}

fn not_found() -> Served {
    Served {
        status: StatusCode::NOT_FOUND,
        mime: "text/plain",
        csp: FILE_CSP.into(),
        body: Vec::new(),
    }
}

fn base(id: &str) -> String {
    format!("{ORIGIN}{id}/")
}

/// The IDs and paths that reach a template are plain ASCII from a short list of characters (see `manifest`), so they need no escaping.
pub fn container(id: &str) -> (String, String) {
    let csp = CONTAINER_CSP.replace("{{BASE}}", &base(id));
    let html = CONTAINER_HTML
        .replace("{{CSP}}", &csp)
        .replace("{{BASE}}", &base(id));
    (html, csp)
}

pub fn frame(id: &str, main: &str) -> (String, String) {
    let csp = FRAME_CSP.replace("{{BASE}}", &base(id));
    let html = FRAME_HTML
        .replace("{{CSP}}", &csp)
        .replace("{{BASE}}", &base(id))
        .replace("{{MAIN}}", main);
    (html, csp)
}

fn mime(path: &str) -> &'static str {
    match path
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("js" | "mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        _ => "application/octet-stream",
    }
}

fn page(html: String, csp: String) -> Served {
    Served {
        status: StatusCode::OK,
        mime: "text/html",
        csp,
        body: html.into_bytes(),
    }
}

fn own(mime: &'static str, text: &str) -> Served {
    Served {
        status: StatusCode::OK,
        mime,
        csp: FILE_CSP.into(),
        body: text.as_bytes().to_vec(),
    }
}

/// What a path on the scheme serves; only an enabled plugin's.
pub fn answer(plugins: &Plugins, path: &str) -> Served {
    let Some((id, rest)) = path.strip_prefix('/').and_then(|p| p.split_once('/')) else {
        return not_found();
    };
    if !manifest::is_id(id) {
        return not_found();
    }
    let Ok(installed) = plugins.enabled(id) else {
        return not_found();
    };
    match rest {
        "" => {
            let (html, csp) = container(id);
            page(html, csp)
        }
        "__devot/frame.html" => {
            let (html, csp) = frame(id, &installed.manifest.main);
            page(html, csp)
        }
        "__devot/container.js" => own("text/javascript", CONTAINER_JS),
        "__devot/container.css" => own("text/css", CONTAINER_CSS),
        "__devot/runtime.js" => own("text/javascript", RUNTIME_JS),
        _ if manifest::is_package_path(rest) => match plugins.read_file(id, rest) {
            Ok(body) => Served {
                status: StatusCode::OK,
                mime: mime(rest),
                csp: FILE_CSP.into(),
                body,
            },
            Err(_) => not_found(),
        },
        _ => not_found(),
    }
}

pub fn serve(
    app: &AppHandle,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let path = request.uri().path().to_string();
    let plugins = app.try_state::<Arc<Plugins>>().map(|p| Arc::clone(&p));
    tauri::async_runtime::spawn_blocking(move || {
        let served = match plugins {
            Some(plugins) => answer(&plugins, &path),
            None => not_found(),
        };
        let response = Response::builder()
            .status(served.status)
            .header("Content-Type", served.mime)
            .header("Content-Security-Policy", served.csp)
            .header("X-Content-Type-Options", "nosniff")
            .header("Cache-Control", "no-store")
            .body(served.body)
            .unwrap_or_else(|_| Response::new(Vec::new()));
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::package::Package;
    use std::collections::BTreeMap;

    const MANIFEST: &str = r#"{"id":"com.example.hello","name":"Hello","version":"1.0.0","apiVersion":1,"main":"dist/main.js"}"#;

    fn installed() -> (tempfile::TempDir, Plugins) {
        let data = tempfile::tempdir().unwrap();
        let plugins = Plugins::new(data.path());
        let mut files = BTreeMap::new();
        files.insert(manifest::FILE.to_string(), MANIFEST.as_bytes().to_vec());
        files.insert("dist/main.js".to_string(), b"devot".to_vec());
        files.insert("icon.svg".to_string(), b"<svg/>".to_vec());
        let staged = plugins.stage(Package {
            manifest: manifest::parse_bytes(MANIFEST.as_bytes()).unwrap(),
            files,
        });
        plugins.install(staged.token).unwrap();
        (data, plugins)
    }

    #[test]
    fn serves_the_container_whose_one_frame_is_the_plugin_page() {
        let (_data, plugins) = installed();
        let served = answer(&plugins, "/com.example.hello/");
        assert_eq!(served.status, StatusCode::OK);
        assert_eq!(served.mime, "text/html");
        let html = String::from_utf8(served.body).unwrap();
        assert!(html.contains(r#"<iframe sandbox="allow-scripts" src="devot-plugin://localhost/com.example.hello/__devot/frame.html">"#));
        assert!(
            served.csp.contains(
                "frame-src devot-plugin://localhost/com.example.hello/__devot/frame.html;"
            )
        );
        assert!(served.csp.contains("connect-src 'none'"));
        // The header and the page's own policy are one.
        assert!(html.contains(&format!(r#"content="{}""#, served.csp)));
    }

    #[test]
    fn serves_the_plugin_page_with_the_runtime_first_under_a_policy_without_network() {
        let (_data, plugins) = installed();
        let served = answer(&plugins, "/com.example.hello/__devot/frame.html");
        let html = String::from_utf8(served.body).unwrap();
        let runtime = html.find("__devot/runtime.js").unwrap();
        let main = html
            .find(r#"src="devot-plugin://localhost/com.example.hello/dist/main.js""#)
            .unwrap();
        assert!(runtime < main);
        for directive in [
            "default-src 'none'",
            "script-src devot-plugin://localhost/com.example.hello/;",
            "connect-src 'none'",
            "frame-src 'none'",
            "worker-src 'none'",
            "form-action 'none'",
        ] {
            assert!(served.csp.contains(directive), "{directive}");
        }
        assert!(!served.csp.contains("unsafe"));
    }

    #[test]
    fn serves_the_plugin_files_and_its_own_scripts() {
        let (_data, plugins) = installed();
        let main = answer(&plugins, "/com.example.hello/dist/main.js");
        assert_eq!(
            (main.status, main.mime, main.body.as_slice()),
            (StatusCode::OK, "text/javascript", &b"devot"[..])
        );
        assert_eq!(main.csp, FILE_CSP);
        assert_eq!(
            answer(&plugins, "/com.example.hello/icon.svg").mime,
            "image/svg+xml"
        );
        let runtime = answer(&plugins, "/com.example.hello/__devot/runtime.js");
        assert_eq!(runtime.body, RUNTIME_JS.as_bytes());
    }

    #[test]
    fn serves_nothing_else() {
        let (_data, plugins) = installed();
        for path in [
            "/",
            "",
            "/com.example.hello",
            "/com.example.other/",
            "/com.example.hello/../plugins.json",
            "/com.example.hello/%2e%2e/plugins.json",
            "/com.example.hello/devot-plugin.json/x",
            "/com.example.hello/__devot/other.js",
            "/com.example.hello/missing.js",
            "/../plugins.json",
        ] {
            assert_eq!(
                answer(&plugins, path).status,
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
    }

    #[test]
    fn serves_nothing_of_a_plugin_that_is_off() {
        let (_data, plugins) = installed();
        plugins.set_enabled("com.example.hello", false).unwrap();
        assert_eq!(
            answer(&plugins, "/com.example.hello/").status,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            answer(&plugins, "/com.example.hello/dist/main.js").status,
            StatusCode::NOT_FOUND
        );
    }
}
