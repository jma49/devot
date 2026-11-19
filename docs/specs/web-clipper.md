# Web clipper

The Manifest V3 extension in `clipper/` saves an article or selected HTML through Devot's local HTTP API.
It requests only `activeTab`, `scripting`, `storage` and loopback HTTP host permissions.
The popup edits the title and lists notebooks from `GET /v1/notebooks`; saving uses `POST /v1/notes` with `{ title, markdown, notebook }` and a Bearer token.
The background owns network requests, with a 20-second timeout, no redirects and no content or token logging.
The options page stores the port (default `27484`) and token in `chrome.storage.local`, never sync storage.
An empty or inaccessible notebook list disables clipping.
The app must be running with its HTTP API enabled, a read/write token and Allow AI Access on the destination notebook.

Extraction runs in the active page's isolated world through `chrome.scripting.executeScript`, only after an explicit clip action.
Readability parses a cloned document; selection mode clones only the selected HTML and uses the same Markdown converter.
Lazy image URLs and srcsets, including picture sources, resolve before Readability; image sources and links become absolute HTTP(S) URLs.
Images with missing or non-HTTP(S) sources are dropped, including inline data images; no image is downloaded or stored as an attachment.
The existing `src/core/htmlImport.ts` sanitizer and Markdown writer preserve supported headings, lists, code and remote images.
The source URL ends the body on its own line after a blank line.
The extension checks the API's 1 MiB UTF-8 Markdown limit before sending and reports a localized error for oversize clips.
API error codes are translated where known, with a generic localized fallback and no note content in errors.

Run `pnpm clipper:build` to bundle all scripts locally with esbuild; there is no remote code or inline script.
Chrome loads **clipper/dist/chrome** as an unpacked extension.
Firefox loads **clipper/dist/firefox/manifest.json** through temporary add-on debugging, or a signed package for persistent installation.
Firefox uses an event background script because its Manifest V3 implementation does not support background service workers.
The build copies the WebExtension English and Simplified Chinese catalogs into both outputs.
The local API accepts validated extension origins without adding any CORS headers; all existing authentication and access checks remain.
Tests in `tests/clipper/` cover extraction and the client through a real HTTP server, and Rust socket tests cover the origin guard.
