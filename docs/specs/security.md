# Security

Part of the [architecture overview](../architecture.md).

- **Commands are least-privilege.**
  `src-tauri/build.rs` declares every app command (listed by area in `src-tauri/build_commands.rs`), so none is reachable until a capability file (`src-tauri/capabilities/`) grants it to a window.
  Every command validates its arguments in Rust and returns error codes, never content.
  The iPhone's native screens reach the page only through the `SCREENS` area (`screens_post`, `screens_take`), granted to the phone's window alone (`src-tauri/capabilities/phone.json`).
  Swift has no `WKScriptMessageHandler`, so no message from native code reaches the page, or comes back from it, without Rust's validation (docs/specs/iphone-screens.md, Message envelope).
- **CSP** in `src-tauri/tauri.conf.json`: `script-src 'self' tauri://localhost` (the sandboxed diagram frame has an opaque origin, which WebKit matches to no `tauri:` URL as `'self'`, so the app's origin is named), no `'unsafe-inline'`, no `eval`; connections only to the app and Tauri's IPC; images also from https; iframes from https, the app itself (the diagram frame) and `devot-plugin:` (plugins' sandboxed frames, see Extensions).
  `freezePrototype` is on.
  A test checks the policy.
  Styles are never inline: CodeMirror runs in a shadow root, where it adds its styles as constructed stylesheets, which the policy allows.
- External links: `https:` opens in the browser; any other scheme needs an allowlist entry and a confirmation.
- Untrusted URLs (for example, link titles) are fetched by Rust, never by the UI.
- Secrets live in the OS keychain (AI provider keys: see AI > Providers).
- **Files written whole, never through a link** (`src-tauri/src/atomic_file.rs`): everything Rust writes outside the databases (exported notes and attachments, Save Image As, PDFs, diagnostics, the settings files, backups, crash reports, the Markdown mirror's files and manifest) goes to a temporary file in the target's folder, flushed to disk (the mirror's many files are not, see Markdown mirror) and renamed into place; there is no other writer (a policy test, `tests/policy/one-writer.test.ts`, refuses a file created or written by path anywhere else but the log, which appends to its own file in the app's data folder).
  A temporary file is only ever created new (O_CREAT | O_EXCL) under a hidden random name (`.devot-<32 hex digits>.tmp`; a crash report's is its random event ID), so a file or a link already at that name is passed over, never opened: a link planted at a name that could be guessed, in a shared or downloaded folder, would take the bytes wherever it pointed.
  A writer that creates its file by path itself (AppKit's PDF, SQLite's backup) writes inside a new private folder (mode 0700) made the same way in the app's data, which nobody else can reach (the mode keeps others out of the folder, not from swapping it for a link where it sits), and its file is renamed out of it or, for a PDF, copied to the chosen file.
  A file that must not replace anything (a notebook export's files and attachments, diagnostics, the mirror's new files) goes in place only where nothing is yet, and so does a file the mirror moves to a new name or keeps aside: in one step where the file system can (a rename that fails on any name already there, a link included, on APFS and HFS+); elsewhere (FAT, exFAT, many network shares) a new empty file claims the name first, which fails the same way, and the rename goes over it, so only something put over that claim in the instant between could be replaced.
  Either way a move is whole: a file never stays under both names.
  Every write works in a folder opened once, by a handle, never by its path again (`atomic_file::Folder`, safe system calls through `rustix`): a folder the user chose is resolved when it is opened (a link the user picked is followed then, once), and the temporary file, the rename into place, a removal and every folder below are named relative to that handle, one plain name at a time, each folder below opened from its parent and never through a link (`O_NOFOLLOW`; for search alone, `O_SEARCH`, so a folder others may only drop files into still works).
  So a local process that may rename entries in a folder Devot writes to (a shared or synced folder) cannot swap a folder on the way for a link between Devot's checks and its write, move or removal: an export session keeps its folder open from the panel to its last file, a PDF's folder is opened when the save panel closes, Save Image As and diagnostics open theirs once per file, and the Markdown mirror opens its folder once per call, by the path resolved when it was chosen, refusing a link anywhere on it.

## URL scheme

Devot registers `devot://` with macOS (`plugins.deep-link` in `tauri.conf.json`, which the bundler writes into the Info.plist as `CFBundleURLTypes`), so a link opened in another app reaches it (`src-tauri/src/deep_link.rs`, `src/renderer/src/deepLink.ts`).

- **What a URL can do:** `devot://license?key=<key>` offers a license (see below).
  `devot://note/<id>` brings Devot forward (launching it if needed) and opens the note: where it is listed, otherwise in All Notes (Templates for a template), and in the Trash if it is trashed; a note that does not exist shows a notice.
  `devot://command/<id>` runs one of eleven commands that only show something (none makes, changes or removes anything): `palette.open`, `view.allNotes`, `view.trash`, `view.focus`, `view.togglePreview`, `view.split`, `view.write`, `view.edit`, `view.preview`, `app.backups` and `app.checkForUpdates`.
  Rust and the window keep the same list, and a test checks that they agree and that every one is a registry command; a command without a handler at that moment (Edit Mode with no note open) shows a notice.
  `devot://today` opens today's note (see Note templates), making it when it is missing: at most one note a day, so a page that opens it over and over makes one note.
- **Checked in Rust, whole:** a URL is accepted only as `<scheme>://note/<UUIDv7>` (the canonical lowercase form) or `<scheme>://command/<listed id>`, exactly: no query, fragment, escapes, trailing slash, other case or other host, and at most 96 bytes; or as `<scheme>://license?key=<key>`, with nothing after the key, whose characters may be percent-encoded, up to 3,104 bytes.
  Anything else is dropped and logged as `W_DEEP_LINK_REFUSED <code>`, never with its text.
  The window gets the checked link (`{kind, id}`, event `devot://open-url`), never the URL, and reads it again before acting.
  The deep-link plugin's own commands are granted to no window.
- **License links:** Rust verifies the key before the window sees it and sends `{kind: 'license', key, offer}` (the license ID, licensee and the state it would have) or, for a key that fails, `{kind: 'license', code}` alone; it logs `W_DEEP_LINK_LICENCE_REFUSED <code>`, never the URL, and `Debug` never shows the key.
  The main window adds a license to a device that holds none and says so, says nothing changed for the license it holds already, and otherwise asks first (Replace the license on this device?, naming both licensees and license IDs).
  It reads the license from Rust again before it decides.
- **Attachments keep their protocol:** `devot://file/<id>` is the web view's own protocol for attachments (`register_asynchronous_uri_scheme_protocol`); it never reaches LaunchServices, and the URL handler refuses such a URL from another app.
- **Debug builds** answer to `devot-dev://` instead, so a development bundle never takes the links meant for an installed Devot: `pnpm build:debug` builds with `src-tauri/tauri.debug.conf.json`, which registers that scheme, and a debug binary accepts only it.
  Copy Note URI still writes `devot://` (the links notes hold).
  Deep links need a bundle: `tauri dev` cannot receive them on macOS.
- **On the iPhone** Devot answers to `devot://` in every build, and once the native screens are installed a link goes to them as a route, by kinds and IDs only (docs/specs/iphone-screens.md, Routes): a license link only fills the License page's field, and today's note is made only while editing is allowed.
- **Timing:** links wait in Rust until a main window has restored its view and asked for them (`deep_link_take`, granted to the main windows; a reload of a page makes its window wait again until it asks) and then go to the frontmost main window that has asked (see Several main windows), and while the Settings window is open (Settings comes forward; the links follow, in order, once it closes).
  A link that launches Devot reaches it before setup runs, while nothing listens (macOS sends it before `applicationDidFinishLaunching`); the deep-link plugin keeps it as its current URL, and setup takes it from there once it listens, so it waits like any other and runs after the window has restored its last note.
  Setup takes it only once the licence exists (`deep_link::listen` needs it), so a launch's licence link is checked like any other.
  At most 16 links wait, and apart from them up to 64 sets of files from the `devot` command; more links are dropped, and files past that are refused at the hand-off, so the command fails (`E_CLI_HANDOFF_REFUSED`) instead of losing them.
  Files already released to the page wait in its queue, which Rust cannot see, so the hand-off counts imports still open there too (`Imports::open`: scanning or scanned, not yet `import_finish`) and refuses once those plus the ones Rust holds reach 64, rather than looking at its own queue alone.
  The window listens from the moment its page loads and holds what comes until its view is ready; there too at most 16 links and 64 sets of files wait (files dropped there end their import session), and a link the same as the one before, within a second of it, is dropped (a page that opens a link over and over).
  In the window, links run one at a time, each after the window has rendered what the one before did (so a link after `view.trash` sees the Trash), and a link that comes while a sheet (`<dialog>`) is up waits until none is.
  A note the window's lists do not hold yet (another writer made it a moment ago) is looked up in the core before the notice shows.
- **One Devot:** the single-instance plugin (`src-tauri/src/single_instance.rs`) runs first, so a second launch of the binary hands its arguments to the running Devot (which comes forward and takes any URL of its scheme among them) and exits, with status 0 and no alert, before it opens the data folder.
  Its socket is in a folder of the user's own, `devot-<uid>` in the user's temporary folder (`DARWIN_USER_TEMP_DIR`, whatever `TMPDIR` says), made with mode 0700 and refused unless it is a folder owned by the process's effective user; the socket is named after the folder identifier, so a debug build and the release app never meet, and a launch with HOME elsewhere still meets a running Devot of the same kind.
  A file at the socket's place that is not a socket of that user is never written to (`W_SINGLE_INSTANCE_SOCKET_FOREIGN`); the data-folder lock is the safety net either way.
  A hand-off is done only once the running Devot answers it with one byte.
  It answers as it takes the message, before it comes forward and finds the files (which can take longer than a sender waits); one that is quitting takes none and closes it unanswered (`W_SINGLE_INSTANCE_QUITTING`), and a message over 1 MiB is dropped whole, never cut.
  Only the process that holds an exclusive `flock` on `<identifier>.lock` beside the socket (for its whole life, let go at exit) removes or binds the socket, so of two launches at once the one that goes on to fail (the data-folder lock) never takes the other's socket away, and a full backlog never makes a launch remove a live one; a launch that finds the lock held waits for it on a thread of its own and binds the socket should it outlive the holder.
  At exit Devot removes the socket only if it is still the one it bound (by device and inode).

## Private macOS APIs

Window transparency and the 120 Hz unlock use private APIs, so Devot cannot ship on the Mac App Store.

- All Objective-C and private API code lives in `src-tauri/src/native/macos/`, and the iPhone app's UIKit code (public APIs only) in `src-tauri/src/native/ios/`: the only modules allowed to use `unsafe`.
  Every block carries a `SAFETY` comment.
- Every private call is guarded by `respondsToSelector:`, and so is every message to an object a private call returns, whose answers are checked for their class before use (the 60 fps lookup skips a `_WKFeature` that no longer answers `key`).
  Private calls run inside `guarded`, which catches an Objective-C exception (`objc2::exception::catch`) as well as a Rust panic: `catch_unwind` alone cannot stop an Objective-C exception, which aborts the app when it unwinds into Rust.
  When an API is missing or throws, the app falls back (60 fps, or an opaque window) and logs a code; it never crashes.
- `src-tauri/tests/main_thread.rs` checks on the main thread that the 60 fps preference can be found and toggled, that the lookup gives no feature (and no crash) for objects that do not answer `key` or a list that is not one, that an Objective-C exception inside a guarded call gives the fallback, and that the system accent reads.

## HTML and embeds in notes

Notes are not only written by the user: imports, sync and AI also write them.
So the preview treats note content as untrusted.

1. **Devot's own page:** HTML is sanitized with a tag and attribute allowlist (`rehype-sanitize`).
   Scripts, event-handler attributes and `javascript:` URLs are removed.
   Safe tags such as `sub`, `sup`, `kbd`, `mark`, `details` and `summary` stay.
2. **`<iframe>`:** any `https:` source is allowed.
   Devot rewrites its attributes: a forced `sandbox` without top navigation, `allow` limited to fullscreen, picture-in-picture and encrypted media, a strict `referrerpolicy`, and lazy loading.
   Pop-ups open in the system browser.
3. **Loading:** well-known video providers (YouTube via `youtube-nocookie.com`, Vimeo, Bilibili) load directly.
   Other origins show a placeholder ("Embedded content from example.com · Load") and load on click.
   This list controls convenience only, not whether an embed is allowed.
4. **Pipeline:** the core worker parses Markdown, parses raw HTML, sanitizes, then runs the preview renderers (`src/core/preview`), which add Devot's own structure (alerts, swatches, embeds, front matter) to the already-sanitized tree.
   The worker returns a hast tree; the UI patches only the DOM nodes that changed, building them with DOM APIs, never HTML strings.
   For the live preview the page posts only the note's text: the worker also reads the task progress, line count and linked notes beside it and asks for the linked notes' chips (`renderLivePreview`, `src/core/preview/live.ts`), again only when another note opens, the links change or a linked note changes.
   The page reads the editor's text only when something showing it asks for it, and tells those once a frame (`textStore.ts`), so typing with no preview, outline or history bar shown never copies the note.
   Colour swatches get their colour through the CSSOM, so the CSP needs no inline styles.
5. **Links:** clicks in the preview never navigate the app page.
   `devot://note/<id>` opens the note; `https:` goes to the `open_external` command, which accepts only plain https URLs and opens them in the browser through `/usr/bin/open` (the app never waits for it, but a thread of its own reaps it, so no defunct `open` stays behind until quit).
   New-window requests from embeds are routed the same way by the main window's new-window handler and never create app windows.
   Every app window also has a navigation guard (`src-tauri/src/navigation.rs`), so a renderer bug cannot load another page into it.
   WebKit on macOS asks the guard about every frame, not only the main one, and Devot has no native main-frame check, so the guard is by window: windows that show no frames (Settings, quick capture, the command-line export) allow only the app's own origin (and the dev server's in `pnpm dev`); main and note windows allow the app's origin, `https:` (embeds) and `devot-plugin:` (plugin frames), so `file:`, `javascript:`, `devot:`, `data:` and plain `http:` navigations, top-level or in a frame, are refused and logged by scheme.
   The paste chooser's page titles and GitHub snippets (`link_title`, `github_snippet` in `src-tauri/src/link_info.rs`) are fetched in Rust, never by the page, so the CSP stays as it is; they run only once the user highlights or picks a format that needs them.
   Every outbound request goes through `src-tauri/src/net.rs`: https only and public hosts only on every redirect hop (at most 5), by name and by the addresses the name resolves to, one 10 s cap for the whole call, a cap on the bytes read, and errors as codes, never URLs.
   A name may resolve into 198.18.0.0/15, where VPN apps in fake-IP mode answer every name and route it by name; a URL naming such an address is still refused, and TLS still checks the name, so a host on a network using that range cannot answer.
   GitHub is called without authentication, so only public repositories work.
   A blob link leaves the `/` of a branch name unencoded, so a snippet tries the ref as one segment after `blob`, then longer (up to 4), while the answer is not found, all within the one 10 s cap.
6. **Extension point:** preview renderers register through a versioned registry (`PREVIEW_API_VERSION`); the built-in features use the same API.
   A renderer may be async and load its library only when the note needs it (math loads temml, emoji loads the shortcode table).
   Content that needs the page's layout engine is an _island_: the worker marks it, the patcher leaves its children alone, and a UI-side island registry (same API version) renders it.
7. **Math, Mermaid, emoji:** math renders to MathML with temml (no fonts or inline styles; the web view lays it out) and passes a MathML allowlist.
   Inline `$` next to a space stays text, so prices are not math.
   Mermaid is an island.
   It runs in a hidden frame (`mermaid.html`), created on the first diagram and removed 30 s after none is shown ([Performance](performance.md)), because Mermaid and its libraries assign to prototypes, which fails in the main window where `freezePrototype` freezes `Object.prototype` (Tauri freezes the main frame only).
   The frame is sandboxed (`sandbox="allow-scripts"`), so its origin is opaque and it cannot reach the main window or its IPC even if a diagram ran script in it.
   An opaque origin makes every module script, dynamic `import()` and `crossorigin` stylesheet a CORS request from `null`, which the app's asset protocol refuses, so the frame loads classic scripts only: `mermaid-frame.ts`, and each diagram engine (`diagram-engines/`: Mermaid, PlantUML, markmap) when the first diagram that needs it is drawn, each built as an IIFE with its dynamic imports inlined (`scripts/vite/mermaid-frame.ts`, a Vite plugin that serves them in dev and emits `mermaid-frame.js` and `mermaid-frame-<engine>.js` into the build, so `pnpm dev`, `pnpm ui:build` and the UI tests all use them and nothing generated is tracked).
   An engine registers itself on the frame's window; a script that fails to load fails that drawing as one that may pass, and is asked for again with the next one.
   Its one style is set through the CSSOM.
   The handshake accepts only the opaque origin `null` and only from the frame's own window.
   The frame talks to the preview only through a private `MessagePort`; the preview rebuilds the returned SVG node by node so the strict CSP holds: its `<style>` becomes a constructed stylesheet and `style` attributes go through the CSSOM.
   Mermaid diagram CSS cannot load remote resources: a note's directive or front matter cannot set `themeCSS`, `themeVariables`, `fontFamily` or `altFontFamily` (they join Mermaid's `secure` keys), the preview drops every declaration, rule or attribute that names a URL other than a same-document `#` fragment, an image function or an `@import` (`preview/diagram-css.ts`), and the frame's own page allows images only from `'self'`, `data:` and `blob:`.
   The preview sends one request at a time (Mermaid's settings are global) and the frame draws each in a container of its own; a failure says why: an error in the source stays until the source changes, and so does a returned drawing that cannot be read (logged with its code); a failure that may pass (a drawing that broke, no answer in time: the limit starts when the request is sent, and loading the frame has a longer limit of its own, so a slow start is not a failure) is logged with its code and drawn again at the next mount, and only its message says it is tried again.
   A drawing's stylesheet is freed when the drawing is replaced or removed and when the preview closes.
   The CSP's `frame-src` allows `'self'` for this frame; notes can still only embed https.
8. **Code blocks:** the fence's info string (` ```js `, ` ```js:app.js `, ` ```js title="app.js" `) is read from the note's Markdown at the block's position. A block with a language or a title gets a header with the language's name and mark (an SVG path from a fixed table, `design/icons/languages.json`) and its title as text; the page's copy button sits in that header. Highlighting is lowlight with a fixed set of highlight.js grammars, loaded only for notes that need one; its output is `span.hljs-*` and text, coloured by the syntax tokens.
   Blocks over 20,000 characters stay plain.
   A render draws each mark once, as a `<symbol>` (id `devot-code-mark-<name>`) inside its first block's mark, and every block's mark shows it with `<use href>`, so the path does not travel to the page once per block.
   A note's own ids carry the sanitizer's `user-content-` prefix, so none can stand in for a mark's symbol.
   Each render, and so each preview piece, gallery card and exported page, carries the symbols it uses; `pageBody` draws the path into every mark again.
9. **Task lists and front matter:** a task's checkbox carries where its mark is in the Markdown (`data-task-at`); a click in the preview ticks it through the editor, which checks the text is still that box.
   Exported pages disable every box.
   Front matter that is a map of keys shows as a compact properties block (lists as chips); other YAML shows as code.
   The main window leaves it out of the live preview (`frontMatterInInfo` in the preview options) and shows it in Note Info's Properties instead, built by the same rule (`frontMatterView` in `src/core/preview/frontMatterView.ts`, through the worker's `noteFacts`) and drawn as React text, never as HTML.
   There the `tags` row shows the tags as the import reader reads them (`readFrontMatter`), each chip in its tag's colour with the header's chip classes and tokens (plain when no tag of that name has a colour), and the `title`, `status` and `tags` rows that differ from the note show the note's value in a quiet badge ("Note: Active") and an Apply button (a button in the row): it sets the field through the same services as the title field and the header pickers, so undo, sync and saving are theirs (status read as import reads it; tags made when missing, as templates make them, and the note's other tags taken off; the title cut to the title limit on one line).
   Status text that names no status shows the badge without Apply, and a read-only window shows no Apply.
   Front matter stays text in the body: nothing is read from it on save.
   HTML export, Copy as HTML, print and PDF, templates and the note window's preview get no note fields and show front matter as written, in the body.
10. _Later hardening:_ render the preview in a script-less sandboxed iframe, with math and Mermaid pre-rendered to SVG in the worker.
