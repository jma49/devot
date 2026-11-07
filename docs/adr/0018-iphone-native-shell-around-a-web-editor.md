# The iPhone's navigation is native and its editor a web view

Status: accepted (2026-11-06); it supersedes ADR 0010 once stage 4 below ships, and the web shell keeps ADR 0010's CSS glass until then.
The detail is in `docs/specs/iphone-screens.md`.

Today the whole iPhone interface is drawn in the one web view: pushes are CSS layers on a reducer, and the tab bar, its lens, the sheets and the glass are drawn by hand (ADR 0010).
Everything that moves runs at WebKit's 60 Hz, the glass's backdrop filters on many layers cost frames, the pop does not follow the finger, and the system's tab bar, search, menus, sheets and glass are imitations of themselves.

## Decision

- **tao keeps the window and its root view controller.** A new Swift package, `DevotScreens` (beside `src-tauri/apple/DevotStore` and linked the same way), adds `ScreensRootController` as a child of tao's root view controller, pinned to its edges.
  Nothing in tao or wry is patched.
- **Structure is UIKit's own.** A `UITabBarController` holds Notes, Library, Activity and Settings and the system's Search tab, each tab has one `UINavigationController`, and sheets and menus are the system's.
  Push, pop, the edge swipe, sheets, menus, swipe actions and search run at the display's rate with the system's timing.
- **One web view for the whole process, long-lived and never out of the window.** It runs the core worker (data model, Yjs, sync engine, link index) as it does now, and it draws the editor and the rendered note.
  It rests in `WebStage`, a view at the back of the root, when no editor is on top, and moves into the `EditorScreen` that is.
  It is never removed from the window, never hidden and never resized by a move.
- **Reads that SQLite answers alone go Rust-direct; every write goes through the core.** Rows, notebooks, tags, saved searches, the Trash, the licence, sync status and settings come from Rust over a C ABI, through the same functions the Tauri commands call.
  Excerpts, headlines, search parsing and every write to notes, notebooks, tags or saved searches go to the core over the bridge.
  Domains Rust owns already (licence, purchases, sync configuration, editor settings, fonts, AI keys, backups) are read and written from Swift through Rust.
- **No `WKScriptMessageHandler`.** Swift reaches the page only through Rust: a C call into Rust, a Tauri event to the main window, and the page's replies through `screens_post`.
  Every operation is a declared command (`screens_post`, `screens_take`) in its own `SCREENS` area of `src-tauri/build_commands.rs`, granted in `src-tauri/capabilities/phone.json` and validated in Rust.
- **A kill switch.** At start the page asks `screens_take`, whose `installed` says whether the native screens attached.
  When the install fails, or is turned off, the page mounts today's web shell unchanged.
  The path stays until stage 4 has shipped one release with no fallback in crash reports.
- **iOS 26 is the minimum.** It matches the Mac's macOS 26, and the system glass, the Search tab and the tab bar's behaviours need it.
- **The move happens in stages, and each ships alone.** Stage 0 is groundwork with no visible change: the package installed empty, the bridge, generated Swift tokens and strings, and spikes on a device.
  Stage 1 brings the native tab bar, Settings and Appearance; stage 2 the native lists, search, New Note and the editor push; stage 3 the editor's native chrome, deep links and restoration; stage 4 Activity and the removal of the web shell.

## Why

- The felt smoothness is structural: system motion at the display's rate, the edge swipe that carries the real screen under the finger, and the system's own glass cannot be drawn in CSS at that cost.
- The editor stays a web view because CodeMirror with Yjs, the rendered note, the find bar and plugin frames are shared with the Mac, and a native editor would be a second editor to keep in step.
- One web view, because a second one would start a second core on the same database: two replicas of a note in memory and two sync engines.
  A web view that leaves the window or is hidden turns `hidden` to WebKit, which stops its frames, throttles its timers and can suspend it, stalling the core and sync.
- tao's controller stays root because tao reads the root's view when the scale changes and sets the root again when a scene connects; replacing it would break across tao updates.
- A `WKScriptMessageHandler` would be a second way into the page that skips the capability files and Rust's validation, and plugin frames could reach it unless every handler checked the main frame.
- A C ABI to Swift, not a Tauri mobile plugin, keeps `unsafe` in `src-tauri/src/native/ios/`, as ADR 0014 chose for `DevotStore`.

## Considered and not chosen

- Making `ScreensRootController` the window's root and tao's controller its child: tao resets its root's frame and re-sets the root, and its view would leave the window while no editor shows.
- Starting Tauri inside an app of Devot's own: tao asserts that `UIApplicationMain` has not run, so it needs a forked tao.
- A web view per screen or per note: a core per web view.
- A native text editor: it would drop the shared editor, its Yjs binding and the preview.
- Keeping the web shell and tuning it: the motion would stay WebKit's and the glass a drawing.

## Consequences

- `unsafe` Rust for the screens lives only in `src-tauri/src/native/ios/`, in a `screens` module shaped like `store.rs`; Swift does the UIKit work, and any private selector is guarded with `respondsToSelector:` and falls back.
- The message envelope has three implementations, TypeScript, Rust and Swift, held together by shared fixtures that all three test suites read.
- Glass is the system's, on the navigation layer only; content is never glass, and no `backdrop-filter` stays in the page once the web shell goes.
- Colours, sizes, motion and strings reach Swift only through generated files from the design tokens and the message catalog; Swift never writes a colour literal or a user-facing string.
- Swift logs through Rust, so its lines carry codes and IDs only and land in the same log files.
- Spikes on a device settle what the design leaves to measurement before the stages that depend on them start: reparenting the web view, the keyboard after a native tap on New Note (a public path is preferred), the bridge's latency, the page as its own scroller, and the system bars' tint.
- `design/motion.md` and `design/phone.md` change stage by stage, as each interaction is built, and are rewritten for system motion when the web shell goes.
