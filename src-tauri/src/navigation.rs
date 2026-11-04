//! Navigation guards for the app's web views. WebKit on macOS asks the handler about every frame,
//! not only the main one, so a window that shows embeds and plugin frames allows their schemes
//! too; a window with no frames allows only the app's own pages. Links in the preview never
//! navigate either way: the page sends them to the browser (`external`).

use tauri::{Manager, Runtime, Url};

/// Where the app's own pages are served from, by platform and dev server.
#[derive(Clone, Debug)]
pub struct AppOrigins {
    pages: Vec<Url>,
}

impl AppOrigins {
    pub fn new(dev_url: Option<&Url>) -> Self {
        let mut urls: Vec<Url> = [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ]
        .iter()
        .filter_map(|url| Url::parse(url).ok())
        .collect();
        urls.extend(dev_url.cloned());
        Self { pages: urls }
    }

    pub fn of<R: Runtime, M: Manager<R>>(manager: &M) -> Self {
        let dev_url = tauri::is_dev()
            .then(|| manager.config().build.dev_url.as_ref())
            .flatten();
        Self::new(dev_url)
    }

    /// A page of the app itself.
    pub fn allows_page(&self, url: &Url) -> bool {
        // By scheme, host and port: `url` gives custom schemes such as tauri: an opaque origin.
        url.host().is_some()
            && self.pages.iter().any(|page| {
                page.scheme() == url.scheme()
                    && page.host() == url.host()
                    && page.port_or_known_default() == url.port_or_known_default()
            })
    }

    /// A page of the app, or what its pages frame: https embeds and plugin frames.
    pub fn allows_framed(&self, url: &Url) -> bool {
        let plugin = crate::plugins::serve::SCHEME;
        self.allows_page(url)
            || matches!(url.scheme(), "https")
            || url.scheme() == plugin
            // Windows serves a custom scheme as http://<scheme>.localhost.
            || (url.scheme() == "http"
                && url.host_str() == Some(format!("{plugin}.localhost").as_str()))
            || matches!(url.as_str(), "about:blank" | "about:srcdoc")
    }
}

fn refused(url: &Url) {
    log::warn!("W_NAVIGATION_REFUSED {}", url.scheme());
}

/// For windows that show no frames: settings, quick capture, the command-line export.
pub fn app_pages_only(origins: AppOrigins) -> impl Fn(&Url) -> bool + Send + 'static {
    move |url| {
        let allowed = origins.allows_page(url);
        if !allowed {
            refused(url);
        }
        allowed
    }
}

/// For main and note windows, whose previews frame embeds and plugins.
pub fn app_and_frames(origins: AppOrigins) -> impl Fn(&Url) -> bool + Send + 'static {
    move |url| {
        let allowed = origins.allows_framed(url);
        if !allowed {
            refused(url);
        }
        allowed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    fn origins() -> AppOrigins {
        AppOrigins::new(Some(&url("http://localhost:5173")))
    }

    #[test]
    fn app_pages_are_allowed_everywhere() {
        let origins = origins();
        for page in [
            "tauri://localhost/index.html",
            "tauri://localhost/mermaid.html",
            "http://tauri.localhost/settings.html",
            "https://tauri.localhost/note.html?id=x",
            "http://localhost:5173/quick-capture.html",
        ] {
            assert!(origins.allows_page(&url(page)), "{page}");
            assert!(origins.allows_framed(&url(page)), "{page}");
        }
    }

    #[test]
    fn windows_without_frames_refuse_everything_else() {
        let origins = origins();
        for page in [
            "https://example.com/",
            "http://example.com/",
            "http://localhost:5174/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "devot://note/x",
            "devot-plugin://localhost/com.example.hello/__devot/frame.html",
            "data:text/html,x",
            "blob:tauri://localhost/x",
            "about:blank",
            "tauri://evil/index.html",
        ] {
            assert!(!origins.allows_page(&url(page)), "{page}");
        }
    }

    #[test]
    fn framing_windows_allow_embeds_and_plugin_frames() {
        let origins = origins();
        for page in [
            "https://www.youtube-nocookie.com/embed/x",
            "devot-plugin://localhost/com.example.hello/__devot/frame.html",
            "http://devot-plugin.localhost/com.example.hello/",
            "about:blank",
        ] {
            assert!(origins.allows_framed(&url(page)), "{page}");
        }
    }

    #[test]
    fn framing_windows_refuse_other_schemes() {
        let origins = origins();
        for page in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "devot://note/x",
            "http://example.com/",
            "data:text/html,x",
            "blob:https://example.com/x",
            "ftp://example.com/",
            "about:config",
        ] {
            assert!(!origins.allows_framed(&url(page)), "{page}");
        }
    }

    #[test]
    fn the_dev_server_is_allowed_only_when_given() {
        let page = url("http://localhost:5173/index.html");
        assert!(!AppOrigins::new(None).allows_page(&page));
        assert!(AppOrigins::new(Some(&page)).allows_page(&page));
    }
}
