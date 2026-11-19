# Web clipper

The Manifest V3 extension in `clipper/` saves an article or selected HTML through Devot's local HTTP API.
It requires only `activeTab`, `scripting`, `storage` and loopback HTTP host permissions.
HTTP and HTTPS image-host access is optional and requested from Enable offline images in the persistent options tab, so a denied prompt still permits clipping with remote images.
The popup never opens a permission prompt because a browser's native dialog can close the popup and interrupt the clip.
The optional patterns cover all HTTP(S) hosts because an article can embed images from any CDN; the background fetches only the first 50 distinct image URLs extracted from that clip, never sends the API token to those hosts and omits cookies.
The popup edits the title and lists notebooks from `GET /v1/notebooks`; saving uses `POST /v1/notes` with `{ title, markdown, notebook }` and a Bearer token.
The background owns network requests, with a 20-second timeout and no content or token logging; API requests refuse redirects.
The options page stores the port (default `27484`) and token in `chrome.storage.local`, never sync storage.
It also displays its own extension origin without a trailing slash, with a Copy origin button.
Copy that origin into Devot Settings > Integrations > Local HTTP API > Browser extensions and choose Add extension before clipping.
No extension is registered by default; up to eight can be registered, and removal takes effect on the next request without restarting Devot.
An empty or inaccessible notebook list disables clipping.
The app must be running with its HTTP API enabled, a read/write token and Allow AI Access on the destination notebook.

Extraction runs in the active page's isolated world through `chrome.scripting.executeScript`, only after an explicit clip action.
Readability parses a cloned document; selection mode clones only the selected HTML and uses the same Markdown converter.
Lazy image URLs and srcsets, including picture sources, resolve before Readability; image sources and links become absolute HTTP(S) URLs.
Images with missing or non-HTTP(S) sources are dropped, including inline data images; srcset parsing keeps commas inside data URLs so their payloads cannot become page-relative URLs.
Heading edit links, section buttons and hidden controls are removed before Readability runs.
The title prefers Open Graph metadata, removes a matching site-name prefix or suffix and otherwise removes a trailing site segment separated by a dash or pipe.
The extracted title wins over the browser tab's title unless the user edited the popup field.
Tracking parameters (`utm_*`, click IDs and common analytics identifiers) are stripped from links, images and the source URL without removing other query parameters.
The existing `src/core/htmlImport.ts` sanitizer and Markdown writer preserve supported headings, lists, code and remote images.
The source URL ends the body on its own line after a blank line.
After creating the note, the background downloads images one at a time and uploads supported raster images through `POST /v1/notes/<id>/files`.
It detects image types from bytes, bounds streamed downloads to fit the API's 2 MiB JSON body cap after base64 encoding, and spaces upload requests by at least 120 ms to stay below the API's sustained rate limit.
Each image URL is attempted only once, up to 50 per clip, and all occurrences of a successful upload become `devot://file/<id>` links through a final Markdown PATCH.
The HTTP API exposes no conditional body-version write, so the background re-reads the note immediately before the PATCH and skips it if the Markdown changed during image uploads, preserving user edits and leaving the original remote images in place.
Failed downloads, denied host access, unsupported images, oversized images and refused uploads keep their cleaned remote URLs.
If the final PATCH fails, the popup reports the error; the initial note and any uploaded files remain, as other multi-step API writes do.
The extension checks the API's 1 MiB UTF-8 Markdown limit before sending and reports a localized error for oversize clips.
API error codes are translated where known, with a generic localized fallback and no note content in errors.
An origin refusal (`E_HTTP_ORIGIN_REFUSED`) shows a localized instruction to add the extension in Devot Settings under Local HTTP API > Browser extensions, rather than a generic failure or an error code.

Run `pnpm clipper:build` to bundle all scripts locally with esbuild; there is no remote code or inline script.
Chrome loads **clipper/dist/chrome** as an unpacked extension.
Firefox loads **clipper/dist/firefox/manifest.json** through temporary add-on debugging, or a signed package for persistent installation.
Firefox uses an event background script because its Manifest V3 implementation does not support background service workers.
The app's English and Simplified Chinese `clipper.` catalogs are the sole string source; the build generates WebExtension `en` and `zh_CN` messages in both outputs, stripping the prefix from each key.
The local API accepts only syntactically valid, exactly registered extension origins without adding any CORS headers; all existing authentication and access checks remain.
Tests in `tests/clipper/` cover extraction and the client through a real HTTP server, and Rust socket tests cover the origin guard.
