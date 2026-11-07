# Devot architecture

Status: **v2, agreed 2026-10-09** (moved the shell from Electron to Tauri).
Items marked _open_ are not decided yet and do not block phase 1.

This file is the overview: what Devot is, its phases, stack and process model, the boundaries between its parts and the constraints every change keeps.
The detail of each area is a spec of its own under [`docs/specs/`](specs/).
Read this file first, then only the spec for the area you are touching.
New detail goes into the matching spec; this overview changes only when a boundary or a constraint changes.
Docs are written one sentence per line, so a change touches only the sentences it changes.

## Specs

- [Data model](specs/data-model.md): notes as Yjs documents, metadata merged by HLC, notebooks, tags and names, schema and migrations, the app data folder, saving and quitting, note windows, several main windows, merging, revision history and the activity heatmap.
- [Markdown dialect](specs/markdown-dialect.md): the syntax Devot reads and writes, note links and the link index, attachments and images, purging, and the editor's commands, formatting, slash menu, code blocks and tables.
- [Import and export](specs/import-and-export.md): importing Markdown and HTML files and folders; exporting notes and notebooks as Markdown, HTML and PDF, and printing.
- [Command line](specs/command-line.md): the `devot` command and its subcommands.
- [Markdown mirror](specs/markdown-mirror.md): the folder kept as a Markdown copy of every notebook, its manifest and how it treats files edited outside Devot.
- [Note templates](specs/note-templates.md): templates, their variables and instruction quotes, the starter templates and today's note.
- [Search](specs/search.md): the query syntax, saved searches, results and excerpts, find in a note, and the Write and Split view modes.
- [Editor settings](specs/editor-settings.md): the Editing and Preview settings, their store and how every window follows them.
- [Usage events](specs/usage-events.md): the local usage-event catalog, its store and who may record or read it.
- [Security](specs/security.md): least-privilege commands, the CSP, external links, secrets, files written whole, the URL scheme, private macOS APIs, and HTML and embeds in notes.
- [Sync and encryption](specs/sync-and-encryption.md): iCloud and the relay, the protocol, cost guards, attachments, encryption, vaults, records, store names, enrollment, the client engine, pairing and the recovery key.
- [Updates](specs/updates.md): the updater and its channel feeds, and the daily licence revocation list.
- [Licences](specs/licences.md): how the app verifies and enforces a licence and the trial, the licence Worker and its seats.
- [Local HTTP API](specs/local-http-api.md): the guards every request passes, the calls, and how they reach the core.
- [Menu bar mode](specs/menu-bar-mode.md): keeping Devot in the menu bar, quick capture, and the background start for AI tools.
- [AI](specs/ai.md): MCP through the bridge, access control, writes and authorship, connecting clients, models and providers, Edit with AI and next edit suggestions.
- [Extensions](specs/extensions.md): the internal extension API and third-party plugins.
- [Localisation](specs/localisation.md): the message catalog, placeholders, `Intl` and the rule against CJK characters in code.
- [Design system](specs/design-system.md): the design direction, the assets in `design/`, the app icon, and theming.
- [Native look](specs/native-look.md): the window material and Glass Transparency, menus and context menus, selection and batch changes, drag and drop, the sidebar, note list layouts, keyboard navigation, commands and shortcuts, the command palette and icons.
- [Quality](specs/quality.md): priorities, test layers, data integrity, security tests, static checks, coverage, CI, the workflow, and crash reporting and logs.
- [Performance](specs/performance.md): the product's budgets and the core benchmarks that hold them.
- [First-launch notes](specs/first-launch-notes.md): the "Getting started" notebook a new library gets.

## Product

- A local-first Markdown note-taking app for daily personal use, source-available under FSL-1.1-MIT (`LICENSE`): each release becomes MIT two years after it is published.
  A 30-day trial unlocks everything; after it, notes are read-only (read, search, copy and export) and sync and AI are locked until a license bought once unlocks them all (docs/adr/0006-source-available-and-sold-once.md).
- No Devot account is needed for anything: sync goes through the owner's own iCloud, where devices on one Apple ID join on their own, or through a relay the owner runs, where sync's identity is device pairing (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md, docs/adr/0004-sync-without-accounts.md).
  Either way the store sees only records Devot sealed.
  Accounts and Share on Web wait until a hosted service is decided.
  A hosted relay for people who do not want to run one may come later as a separate, periodically billed storage service, not a license feature; nothing of it is built (docs/adr/0011-optional-hosted-sync-is-a-service-not-a-license-feature.md).
- Billing: one license bought once, checked offline, no account; a 30-day trial first, then read-only (docs/adr/0006-source-available-and-sold-once.md; see Licences).
  Features ask `createEntitlements().has(feature)` (`src/core/entitlements.ts`) with a typed `Feature`.
  `PLAN_GATED_FEATURES` is `editing`, `sync`, `aiProviders` and `semanticSearch` (`localNotes`, reading, searching, copying and exporting, is never gated); a license names a plan (`pro`), and `PLAN_FEATURES` says what the plan grants, so a paid feature added later reaches every license.
  The `EntitlementSource` is the license as Rust checked it (`enforced`, its state and plan, and whether the trial runs): a gated feature needs `valid` and `pro`, or a running trial; nothing is gated while the build holds no production key (`enforced` false).
  The windows only show what is locked; Rust enforces it (`E_LICENCE_REQUIRED`).
- Usage data: the app records usage events through one local interface (event name, time, a few anonymous properties; never note content, titles or names).
  Nothing leaves the device until an opt-in upload ships with accounts (see Usage events).
- Platforms: macOS 26 and later first, then iOS and iPadOS.
  Windows and Linux are out of scope for now; platform code stays isolated (`src-tauri/src/native/`) so they remain possible.
- Layout: three panes (sidebar, note list, editor and preview), keyboard-driven.
  In a narrow window (the minimum is 760 px) the list shrinks to `size.list-min-width` before the editor, which keeps `size.pane-min-width` for each split pane; below `size.sidebar-collapse-width` (1000 px) the sidebar is hidden until Show Sidebar (or Cmd+/) asks for it, a request that lasts until the window crosses that width again and is not stored.
  A split pane's selection toolbar stays on one row and scrolls sideways when the pane is narrower.
- Workspaces: Open as Workspace (the notebook menu, or Cmd+Return on a notebook in the palette) makes one notebook the whole sidebar: a title (Go Up a Level, the notebook's icon and name, the notebooks above it, each opening as the workspace; its menu renames, changes the icon or copies the ID), All Notes (the notebook with its sub-notebooks), its sub-notebooks, and Status and Tags counted over its notes only, listing only the tags they have.
  Pinned, Templates and the Trash are hidden, and the tag menu has no Delete Tag there.
  Go Up a Level (Backspace on a row that is neither a notebook nor a tag, where Backspace deletes; Cmd+Up on any row) opens the parent notebook as the workspace, or leaves workspaces at the top level; Leave Workspace in the palette leaves at once.
  A view outside the workspace (All Notes, Templates, the Trash, a notebook outside it), a note opened outside it (a note link, the palette, a search over every note) or the notebook being deleted leaves it.
  The workspace is per window, kept in the window's last state (`lastState.ts`) and dropped on restore when its notebook is gone.
- Language: the UI ships in English.
  Other languages come later (see Localisation).

## Phases

| Phase          | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (MVP, macOS) | Nestable notebooks, tags, note statuses (none, active, on hold, completed, dropped), pinning, trash. Attachments, including pasted images. Distraction-free mode. Light and dark themes. Markdown and HTML import; Markdown and HTML export; print; a Markdown folder mirror. Math, Mermaid and emoji built in. Note links with `[[` insertion and a link index. MCP: search, read, note and notebook creation, edits and trashing, with a setup helper in Settings. Automatic local backups. Crash reporting (Sentry) and local logs. UI integration tests (Playwright). Local activity heatmap; the usage-event interface (local only); a slider for Glass Transparency. |
| 2              | Sync and E2EE. Full-app end-to-end tests and the performance harness on macOS. AI edit proposals. Local semantic search. Backlinks panel and graph view. GitHub embeds, link title fetching. Entitlements interface. Local HTTP API. Menu bar mode with quick capture. Several windows. More AI providers.                                                                                                                                                                                                                                                                                                                                                                 |
| 3              | iOS / iPadOS app (same Tauri project). In-app AI assistant. Third-party plugins. Share on Web waits for a hosted service (ADR 0004).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Stack

| Area            | Choice                                                                     |
| --------------- | -------------------------------------------------------------------------- |
| Shell           | Tauri 2 (system WKWebView), Rust                                           |
| UI              | React + TypeScript (strict), Vite                                          |
| Editor          | CodeMirror 6                                                               |
| Storage         | SQLite in Rust (rusqlite, FTS5); better-sqlite3 for tests                  |
| CRDT            | Yjs                                                                        |
| Tooling         | pnpm, oxlint + oxfmt, lefthook; cargo fmt, clippy, cargo-deny              |
| Testing         | Vitest, fast-check, Playwright (WebKit); cargo test; WebdriverIO (phase 2) |
| Crash reporting | Sentry (Rust SDK and browser SDK)                                          |
| Packaging       | `tauri build` on tags, notarized Developer ID, updater (`releasing.md`)    |

### Why Tauri

Measured on the same CodeMirror page with a 10k-character note, M1 Pro, macOS 27.2, built-in 120 Hz display:

| Metric                         | Electron 44           | Tauri 2                              |
| ------------------------------ | --------------------- | ------------------------------------ |
| App bundle                     | 288 MB (runtime only) | 9.5 MB                               |
| Launch to first editor paint   | 891–1147 ms           | 583–638 ms                           |
| Memory footprint with the note | 262–279 MB            | about 160–230 MB (approximate)       |
| Change to paint, median / p95  | 8.3 / 9–10 ms         | 8 / 10 ms with the 60 fps cap lifted |
| Idle CPU, static page          | ≈ 0 %                 | ≈ 0 %                                |

Tauri also runs the same code on iOS.
Its costs: WKWebView paces rendering at 60 fps unless a private WebKit preference is turned off, and window transparency (needed for the window material) uses a private API too; both rule out the Mac App Store.
Window transparency has a reported GPU power cost on some Macs (tauri-apps/tauri#15471); GPU power is measured in the phase 2 harness.

## Process model

```
┌────────────────────────── WKWebView (UI) ──────────────────────────────────┐
│ React UI · CodeMirror 6 · preview DOM · strict CSP, no Node                 │
│                                                                             │
│  Core worker (Web Worker): data model · Yjs · Markdown · link index ·       │
│  import / export rules · sync engine                                        │
└──────────────┬──────────────────────────────────────────────────────────────┘
               │ Tauri commands (each one granted by a capability file)
┌──────────────┴────────────── Rust (app process) ───────────────────────────┐
│ storage: SQLite + FTS5 (own thread) · files · encryption ·                  │
│ native: window material, 120 Hz, SF Symbols, accent colour · menus          │
└─────────────────────────────────────────────────────────────────────────────┘

devot --cli mcp (run by AI tools, stdio) ── the same binary as a small bridge:
no database, no notes, calls the running app's local HTTP API (see AI)

devot --crash-reporter (builds with a Sentry DSN only) ── a second copy of
the app binary that waits for the app to crash and saves a scrubbed report
```

### Who does what

- **Rust:** what is performance-sensitive or needs the system: SQLite reads and writes (on a dedicated thread), FTS5, file I/O, encryption, native window features, and later local embeddings.
- **TypeScript core:** the logic: data model, Yjs, Markdown, link index, import and export rules.
  It runs in a Web Worker so the UI thread never waits on it.
- **Moving work to Rust:** when a piece of core logic is measured as a bottleneck, or must keep running with no window open (for example the sync engine), it moves to Rust behind the same interface.

### Core library boundaries

The core is plain TypeScript, so the UI worker and the iOS app share it.

- The core imports neither `@tauri-apps/*`, `better-sqlite3` nor Node built-ins.
  It talks to storage through an adapter interface: the app's adapter calls Tauri commands; tests use better-sqlite3.
- Tauri commands are reachable from the page only, so the core worker's storage calls cross to the page (`src/renderer/src/storage/wire.ts`).
  A note's or a version's Yjs state crosses as the base64 string the commands take, coded in the worker (by the engine's own `toBase64` and `fromBase64` where it has them), and the worker also finds a note's links and checks its limits; the page hands what it gets to the commands as it is, so a save or an open costs the UI thread no work for each byte of a state (several MiB for a long, much-edited note).
  Opening a note for its editor sends the whole state once, as bytes (`note_open`, `openNote`): a 4-byte length, the note's fields as JSON, then the Yjs state as stored, without the body, which the core reads from the state it builds the note from.
  The page hands the bytes to the worker without reading them (a 2.4 MB note: 2.4 MB instead of a 5.6 MB JSON reply whose parse took the page 9 ms); `note_get` stays for every other read, the Trash's too; selecting a note asks the core for its title alone (`title`), and when another process wrote to the open note, the editor's replica takes in only what it lacks (`open` with the replica's state vector).
  A first open still builds the replica from the whole state, which for a heavily edited note costs what its history weighs (sync does not change this, ADR 0002).
- Every data API is async.
- No plugin process: third-party plugins run in sandboxed frames of the main window (see Extensions, ADR 0005).

## Hard constraints

Every change keeps these; each spec has the detail.

- When trade-offs collide, data integrity comes first, then security, performance, functional correctness and visual polish ([Quality](specs/quality.md#priorities)).
- A note's Yjs document is the source of truth for its body, and nothing writes the Markdown snapshot directly: import and MCP note creation apply a text diff as Yjs operations ([Data model](specs/data-model.md)).
- IDs are UUIDv7, deletes are soft, and metadata fields are last-writer-wins by a hybrid logical clock that storage itself enforces ([Data model](specs/data-model.md)).
- The core imports neither `@tauri-apps/*`, `better-sqlite3` nor `node:*`, and the UI imports no Node modules; lint rules enforce it ([Quality](specs/quality.md#static-checks)).
- Every Tauri command is declared in `src-tauri/build.rs`, granted to a window by a capability file, validates its arguments in Rust and returns error codes, never content ([Security](specs/security.md)).
- Note content is untrusted: the preview sanitizes it, the CSP allows no inline scripts or `eval`, and untrusted URLs are fetched by Rust, never by the UI ([Security](specs/security.md#html-and-embeds-in-notes)).
- Secrets live in the OS keychain, and Rust writes every file outside the databases whole, never through a link ([Security](specs/security.md)).
- Objective-C and private API code lives only in the native modules, each private call guarded by `respondsToSelector:` ([Security](specs/security.md#private-macos-apis)).
- Sync stores only records Devot sealed in Rust; the relay sees ciphertext only ([Sync and encryption](specs/sync-and-encryption.md)).
- AI sees only live notes filed directly in notebooks whose owner allowed AI access, and every AI write goes through the core ([AI](specs/ai.md)).
- Logs, errors and crash reports carry codes and IDs, never note content ([Quality](specs/quality.md#crash-reporting-and-logs)).
- UI text comes from the message catalog by key, and code holds no CJK characters ([Localisation](specs/localisation.md)).
- The windows only show what a licence locks; Rust enforces it ([Licences](specs/licences.md)).
- Launch to first editor paint stays under 700 ms, idle memory under 200 MB, keystroke to paint within one frame at 120 Hz, search over 10k notes under 50 ms and switching notes under 16 ms ([Performance](specs/performance.md)).

## Data model

A note's body is a Yjs document holding its Markdown; title, notebook, tags, status and pinning are SQL rows, each field merged by a hybrid logical clock.
A Markdown snapshot derived on save serves search, export and MCP.
SQLite migrations are numbered files shared by Rust and the test adapter, and each Devot holds a lock on its own data folder.
The spec also covers saving and quitting without loss, note windows, several main windows, merging, revision history and the activity heatmap.
Spec: [`docs/specs/data-model.md`](specs/data-model.md).

## Markdown dialect

Notes are CommonMark and GFM with front matter, alerts, math, Mermaid, emoji shortcodes and note links that resolve by ID, kept in a link index for backlinks.
The same spec covers attachments, images and purging, and how the editor formats, completes and edits Markdown.
Import and export, the `devot` command, the Markdown mirror and note templates have specs of their own: [`import-and-export.md`](specs/import-and-export.md), [`command-line.md`](specs/command-line.md), [`markdown-mirror.md`](specs/markdown-mirror.md) and [`note-templates.md`](specs/note-templates.md).
Spec: [`docs/specs/markdown-dialect.md`](specs/markdown-dialect.md).

## Search

Search covers live notes through the FTS5 trigram index, with words, quoted phrases and qualifiers for notebooks, tags and statuses, in the current view or over every note.
The spec also covers saved searches, results and excerpts, find and replace in a note, and the Write and Split view modes.
Spec: [`docs/specs/search.md`](specs/search.md).

## Editor settings

Settings > Editing and Settings > Preview are a local preference, not note data: Rust keeps them in the app data folder and sends every change to every window.
Spec: [`docs/specs/editor-settings.md`](specs/editor-settings.md).

## Usage events

The app records usage events through one typed, local catalog that never holds note content, titles or names; nothing leaves the device.
Spec: [`docs/specs/usage-events.md`](specs/usage-events.md).

## Security

Commands are least-privilege, the CSP is strict, external links and untrusted URLs go through Rust, and files are written whole.
The spec also covers the `devot://` URL scheme, the private macOS APIs and how the preview treats HTML and embeds in notes as untrusted.
Spec: [`docs/specs/security.md`](specs/security.md).

## Sync and encryption

A vault syncs through the owner's iCloud or through a relay the owner runs, which stores only the latest sealed state of each record; clients merge.
Encryption is AES-256-GCM in Rust, with keys from device pairing and a recovery key.
Spec: [`docs/specs/sync-and-encryption.md`](specs/sync-and-encryption.md).

## Updates

Tauri's updater reads a channel feed after launch and then on a schedule, and the same scheduler fetches the licence revocation list once a day.
Spec: [`docs/specs/updates.md`](specs/updates.md).

## Licences

Rust verifies a licence key offline against the keys the build holds and enforces the trial and the read-only state; a Cloudflare Worker sells and issues keys and counts seats.
Spec: [`docs/specs/licences.md`](specs/licences.md); the formats are in [`docs/licensing.md`](licensing.md).

## Local HTTP API

Other tools can read and write notes while Devot runs through an HTTP API on `127.0.0.1`, off by default, behind a token, rate limits and validation in Rust; every call goes through the core.
Spec: [`docs/specs/local-http-api.md`](specs/local-http-api.md).

## Menu bar mode

Keep in Menu Bar keeps Devot running with a menu bar icon and quick capture, and an AI tool can start Devot in the background.
Spec: [`docs/specs/menu-bar-mode.md`](specs/menu-bar-mode.md).

## AI

AI tools reach notes over MCP through a bridge in the app binary that calls the local HTTP API, so the running app's core is the only write path.
Each notebook decides whether AI may see it; the spec also covers authorship, connecting clients, providers, Edit with AI and next edit suggestions.
Spec: [`docs/specs/ai.md`](specs/ai.md).

## Extensions

Built-in preview renderers register through an internal, versioned extension API, and third-party plugins contribute commands, menus, keymaps, renderers and formats from sandboxed frames.
Spec: [`docs/specs/extensions.md`](specs/extensions.md).

## Localisation

English is the only locale shipped; every string comes from a typed message catalog by key.
Spec: [`docs/specs/localisation.md`](specs/localisation.md).

## Design system

Native macOS structure with cool neutrals and a blue accent; assets live in `design/` (`design/README.md`), and themes are token files.
The native look of the window, menus, lists and keyboard is its own spec.
Spec: [`docs/specs/design-system.md`](specs/design-system.md) and [`docs/specs/native-look.md`](specs/native-look.md).

## Quality

Tests come in layers from unit to full-app, with crash safety, migration fixtures and merge convergence for data integrity, security tests, static checks and CI on every pull request.
The spec also covers the workflow and crash reporting and logs.
Spec: [`docs/specs/quality.md`](specs/quality.md).

## Performance

The product's budgets and the core benchmarks that hold them.
Spec: [`docs/specs/performance.md`](specs/performance.md).

## First-launch notes

An empty library gets a "Getting started" notebook once.
Spec: [`docs/specs/first-launch-notes.md`](specs/first-launch-notes.md).

## Open questions

1. Whether `design/` becomes its own repository.
2. In-app AI assistant interaction design.
3. Measure idle GPU power with the transparent window; if it is high, drop to an opaque window with a tinted sidebar.
