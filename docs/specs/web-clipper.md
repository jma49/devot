# Web clipper

The Manifest V3 extension in `clipper/` saves an article or selected HTML through Devot's local HTTP API.
It requires only `activeTab`, `scripting`, `storage` and loopback HTTP host permissions.
HTTP and HTTPS image-host access is optional and requested from Enable offline images in the persistent options tab, so a denied prompt still permits clipping with remote images.
The popup never opens a permission prompt because a browser's native dialog can close the popup and interrupt the clip.
Installing the extension opens its options page, which walks through setup in four numbered steps: turn on the API with read and write access, paste the token, add the extension's origin in Devot, and allow AI access on a notebook.
Save and Check stores the settings and runs one check per step in the order the API applies its guards (reachable, origin registered, token accepted, token can write, a notebook open to clips), marking each passed, failed with its fix, or not reached.
The write check posts an empty object to `POST /v1/notes`: Rust refuses a read-only token with `E_HTTP_READ_ONLY` before it reads the body and answers a read/write token `E_HTTP_BODY_INVALID`, so the check never makes a note.
The optional patterns cover all HTTP(S) hosts because an article can embed images from any CDN; the background fetches only the first 50 distinct image URLs extracted from that clip, never sends the API token to those hosts and omits cookies.
The popup shows the page's host and favicon, the cleaned title (editable), the notebooks from `GET /v1/notebooks` with the last one used selected, and an Article or Selection choice that starts on Selection when the page has selected text and is disabled, with a hint, when it has none.
Enter in the title or anywhere outside a control saves; saving uses `POST /v1/notes` with `{ title, markdown, notebook }` and a Bearer token, through a port to the background that reports image progress (`n of m`).
After a save the popup shows the notebook, the title and Open in Devot, which sets the article tab's URL to `devot://note/<id>`; an external scheme launches the app without navigating the tab.
A page that is not HTTP(S) shows that it cannot be clipped before Devot is asked anything.
A refusal that setup can fix (no connection, unknown origin, missing or refused token, read-only token, no notebook) replaces the form with a Connect to Devot message and Open Settings, plus Try Again when Devot was only unreachable; other problems stay inline above the Save button.
Pages follow the app's look: `style.css` bundles the generated `tokens.css`, so colours, type and spacing are Devot's design tokens in light and dark, and the icons are drawn from `design/app-icon`.
The background answers only the extension's own pages (`sender.url` under the extension's origin), never content scripts.
The background owns network requests, with a 20-second timeout and no content or token logging; API requests refuse redirects.
The options page stores the port (default `27484`) and token in `chrome.storage.local`, never sync storage.
It also displays its own extension origin without a trailing slash, with a Copy origin button.
Copy that origin into Devot Settings > Integrations > Local HTTP API > Browser Extensions and choose Add Extension before clipping.
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
Once the note exists, nothing that goes wrong with its images fails the save, so retrying never makes a second note: a failed download, upload, read-back or final PATCH leaves the remote links and the popup says some images stayed web links (or, without image access, how to allow it); any uploaded files remain, as with other multi-step API writes.
The extension checks the API's 1 MiB UTF-8 Markdown limit before sending and reports a localized error for oversize clips.
API error codes are translated where known, with a generic localized fallback and no note content in errors.
An origin refusal (`E_HTTP_ORIGIN_REFUSED`) shows a localized instruction to add the extension in Devot Settings under Local HTTP API > Browser Extensions, rather than a generic failure or an error code.

Run `pnpm clipper:build` to bundle all scripts locally with esbuild; there is no remote code or inline script.
Chrome loads **clipper/dist/chrome** as an unpacked extension.
Firefox loads **clipper/dist/firefox/manifest.json** through temporary add-on debugging, or a signed package for persistent installation.
Firefox uses an event background script because its Manifest V3 implementation does not support background service workers.
The app's English and Simplified Chinese `clipper.` catalogs are the sole string source; the build generates WebExtension `en` and `zh_CN` messages in both outputs, stripping the prefix from each key.
The catalog indexes export the browser-only area separately, not in the app's runtime catalogs, so neither the main window nor the core worker loads extension strings at startup.
The local API accepts only syntactically valid, exactly registered extension origins without adding any CORS headers; all existing authentication and access checks remain.
Tests in `tests/clipper/` cover extraction and the client through a real HTTP server, and Rust socket tests cover the origin guard.
