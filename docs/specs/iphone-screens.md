# iPhone screens

The iPhone's navigation, lists, Settings, sheets and menus are native UIKit screens, and its editor is the one long-lived web view moved into the screen on top ([ADR 0018](../adr/0018-iphone-native-shell-around-a-web-editor.md)).
This spec is the agreement the code is held to: how the screens attach, the bridge and its envelope, which way each operation goes, how the editor screen and the page talk, where glass goes and what Settings holds.
The move happens in stages that each ship alone, and until the last one the web shell in `src/renderer/src/phone/` stays as the fallback.
The iPhone's minimum is iOS 26.
Design rules for the phone stay in `design/phone.md` and `design/motion.md`, which change stage by stage as each interaction is built.

## Shape

```
UIApplication (tao's app delegate, unchanged)
└─ TaoUIWindow (tao)
   └─ TaoUIViewController (tao, stays the root)
      └─ TaoUIView
         └─ ScreensRootController (Swift, a child controller pinned to all edges)
            ├─ WebStage (1 × 1 pt at the back, alpha 1, never hidden, out of the accessibility tree): the web view rests here
            └─ UITabBarController (the system tab bar)
               ├─ Notes     UINavigationController → note list → EditorScreen
               ├─ Library   UINavigationController → Library → note list → EditorScreen
               ├─ Activity  UINavigationController → Activity (in the page until stage 4)
               ├─ Settings  UINavigationController → Settings root → panes
               └─ Search    (the search tab role) → search with scopes All and Titles
            sheets: the system's sheet presentation   menus: UIMenu and context menus
```

- **Swift.** The `DevotScreens` package sits beside `src-tauri/apple/DevotStore` and is linked the same way.
  `Bridge.swift` holds the C ABI and is its only file with `Unsafe*Pointer`.
  `Model/` holds the Codable messages, the navigation state, the restoration codec and the routes, pure logic tested without UIKit.
  `UI/` holds the controllers and the SwiftUI views.
  `Generated/` holds the Swift tokens and strings, generated from the design tokens and the message catalog.
- **Rust.** A `screens` module in `src-tauri/src/native/ios/` holds the C ABI, its `unsafe` blocks with SAFETY comments, the callbacks behind `catch_unwind` and the map of waiting requests, shaped like `store.rs`.
  A platform-free `screens` module in `src-tauri/src/` holds message validation, the phone router and the Rust-direct reads; it compiles for iOS and for tests on the Mac.
  Stage 0 brings its message validation and the waiting requests (`message.rs`, `hub.rs`), and stage 1 the Rust-direct operations (`direct.rs`); the router and the list reads join with the stages that use them.
- **Page.** A `screens` folder in `src/renderer/src/phone/` holds the bridge, the table from operation names to core calls, the change notices and the editor host.
  It runs only when Rust reports that the native screens are installed.

## Install and the kill switch

1. `native::main_window_built` (`src-tauri/src/native/mod.rs`) installs the screens after it hides WebKit's bar above the keyboard.
2. On the main thread, inside `with_webview`, Rust passes the web view and tao's view controller to the package's install function, which answers `true` or `false`.
3. Swift checks both objects' classes, attaches the root and builds the containers.
   Tao's window need not be up yet: containment needs none, and the root follows the window's bounds once it is.
   Swift moves the web view only from a screen's `viewIsAppearing`, when it has a window, so the web view's window is never nil.
   Stage 0 attached only the empty root; stage 1 attaches the tab bar over the web view (Tabs, below).
   Once the root appears with its scene foreground-active, Swift makes tao's window key, which tao leaves to another window after launch, and logs `I_SCREENS_WINDOW_KEY`; it checks again each time the scene becomes active.
4. On `false` the app keeps today's web shell unchanged.
   Swift answers `false` when the kill switch is on or when an object is of another class, and logs why with a code.
5. At start the page calls `screens_take`, which answers `{ installed, pending }`: whether the screens attached, and the operations queued before the page listened.
6. With `installed` the page mounts the editor host alone (no tab bar, lists, sheets or glass); otherwise it mounts the web shell.
   Both paths start the core and seed the welcome notes the same way.

The kill switch is the `DevotScreensOff` key of the app's own `UserDefaults`, which the launch argument `-DevotScreensOff YES` sets for one run; the privacy manifest gives reason `CA92.1` for reading it.
The kill switch stays until stage 4 has shipped one release with no fallback in crash reports.
In stage 0 the root was empty and transparent and passed every touch through, so the app behaved exactly as before.

## Bridge

| From → to    | Channel                                                                                                                 | Use                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Swift → Rust | `call(request, json, len, reply)`, a Rust function handed over at install; Rust validates, then answers through `reply` | Rust-direct reads and writes, and core operations that Rust forwards |
| Rust → Swift | the C call `devot_screens_deliver(json, len)`; Swift copies on the calling thread and hops to the main queue            | change notices, licence and sync snapshots, routes                   |
| Rust → page  | the Tauri event `devot://screens` to window `main`                                                                      | a core operation for the page to run                                 |
| page → Rust  | the command `screens_post { message }`                                                                                  | an operation's reply, change notices, editor events                  |
| page start   | the command `screens_take`                                                                                              | the mode, and operations queued before the page listened             |

- Swift never talks to the page directly: there is no `WKScriptMessageHandler`.
  Every way into the page is a declared command in the `SCREENS` area of `src-tauri/build_commands.rs`, granted in `src-tauri/capabilities/phone.json` and validated in Rust.
  The debug-only spike harness is the one exception (Spikes).
- The package exports two C functions, `devot_screens_install(webView, root, call, log)` and `devot_screens_deliver(json, len)`.
  Rust hands Swift its own `call` and `log` functions at install, so Rust exports no symbol and Swift needs no header.
- `build.rs` lists the package's C symbols beside the store's, so Cargo's iOS library, which holds no Swift, still links.
- A buffer passed either way is valid only until the call that received it returns, so each side copies it first.
- Rust keeps at most 1024 requests waiting, and refuses more with `E_SCREENS_BUSY`.
- A panic in Rust on a request's way abandons it, and Swift hears `E_SCREENS_INTERNAL` unless it was answered already, so no request waits for ever.
- A request that comes before the page listens waits in Rust until the page calls `screens_take`; one that comes later goes out as the event at once.
- A reload of the page fails the requests it was handed with `E_SCREENS_PAGE_RELOADED`, and the next page takes those still queued.
- Without the screens installed, Rust refuses every request with `E_SCREENS_NOT_INSTALLED` and the page stops listening.
- A no-operation round trip stays within p50 4 ms and p95 10 ms on an iPhone 15 or later.
- A tap never waits on the bridge to move: a push starts at once and the data arrives during it.

## Message envelope

```json
{ "v": 1, "id": 41, "op": "note.create", "args": { "bookId": "0192…" } }
{ "v": 1, "id": 41, "ok": true, "result": { "id": "0193…" } }
{ "v": 1, "id": 41, "ok": false, "code": "E_LICENCE_REQUIRED" }
{ "v": 1, "notice": "notes.changed", "rev": 812, "ids": ["0193…"] }
```

- `v` is the envelope's version, and a message of another version is refused.
- A request carries `id`, `op` and `args`; its reply carries the same `id` with `ok` and either `result` or `code`.
- A notice carries `notice` and its own fields, and no `id`.
- `id` is a `u64` from Swift's own counter, and a reply whose `id` is not waiting is dropped, as `store.rs` drops one.
- Rust validates every message before it forwards it:
  - `op` and `notice` come from closed enums, and unknown fields are refused;
  - note IDs pass `valid_note_id` (`src-tauri/src/commands/notes.rs`);
  - a title is at most `MAX_TITLE_CHARS`, a tag name at most the tag limit, and a search query at most 10 clauses of 100 characters a term;
  - a message is at most 4 MiB, the store bridge's limit.
- A code is for logs and for choosing what to show, never shown to the user.
- Logs carry the operation, the `id` and codes only (`W_SCREENS_OP_FAILED op=note.create code=…`).
  Swift logs through the `log(level, line, len)` function Rust hands it, so its lines land in Rust's log files and pass the same scrubbing.
  Rust takes only a line that starts with a code (`I_`, `W_` or `E_`), in printable ASCII and at most 200 bytes.
- A reply's `code` is an error or warning code (`E_` or `W_`, then capitals, digits and underscores, at most 64 characters); the page sends `E_SCREENS_OP_FAILED` for an error that carries none.
- Valid and invalid messages live as fixtures in a `screens` folder of `tests/fixtures/`, and the Vitest, `cargo test` and XCTest suites all read them, so the three implementations cannot drift apart.
- Stage 0 declares `ping`, `excerpts`, `search` and `note.create`, and the notices `notes.changed` and `editor.title`, so the three validators are tested against more than one shape.
  The page runs only `ping` and answers the others `E_SCREENS_OP_UNSUPPORTED`; each gets its handler with the pull request that first sends it.
  Any other operation joins the enums with the pull request that first uses it.
- An operation whose name starts with `direct.` is one Rust answers itself (Rust-direct operations below), and it is in neither the page's enum nor its fixtures.

## Operations

1. Writes to note data always go through the core, which holds open notes, owns the hybrid logical clock (`src/core/hlc.ts`), keeps the link index, tells sync and derives the Markdown snapshot.
2. Reads that SQLite answers alone go Rust-direct, over the same functions the Tauri commands call, so they reach the same database thread with the same validation and work before the page has started.
3. Reads taken from a body or from pending edits go through the core: excerpts, headlines, previews and search parsing.
4. Domains Rust owns already are read and written from Swift through Rust, and Rust's change events keep the editor in step with a change made in native Settings.

| Operation                                                                   | Path                                  | Function or core call                                                           |
| --------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| Note list rows (title, dates, notebook, status, pinned, tags, body version) | Rust-direct                           | the note list page and summaries reads                                          |
| Notebooks, tags, saved searches, the Trash list                             | Rust-direct                           | the books, tags, saved searches and Trash list reads                            |
| Row excerpts, for visible rows only, at most 60 IDs a call                  | core                                  | `excerpts(ids)`, cached in Swift by note ID and body version                    |
| Search                                                                      | core                                  | `search(query, scope, { flush: true })`: the core parses and Rust's search runs |
| New Note                                                                    | core                                  | `create(title, bookId)`, then the editor opens it                               |
| Today's note, templates, duplicate                                          | core                                  | `openTodaysNote`, `applyTemplate`, `duplicate`                                  |
| Pin, status with undo, notebook, dates                                      | core                                  | `setPinned`, `setStatusUndoable` and `undoStatus`, `setBook`, `setNoteDates`    |
| A note's tags; renaming, colouring and deleting a tag                       | core                                  | `addTag`, `removeTag`, `renameTag`, `setTagColor`, `deleteTag`                  |
| Notebooks: create, rename, move, icon, AI access, remove                    | core                                  | the core's book calls and `setBookAiAccess`                                     |
| Trash, restore, purge, empty                                                | core                                  | `trash`, `restore`, `purge`, `emptyTrash`                                       |
| Several notes at once                                                       | core                                  | `batch(ids, change)`                                                            |
| History, AI edits, import, export                                           | core, drawn in the page until stage 4 | as today                                                                        |
| Licence state and the gate                                                  | Rust-direct                           | `direct.licence.*`, the bodies of the `licence_*` commands                      |
| Purchases, restoring them, the Mac key                                      | Rust-direct                           | `direct.store.*`; StoreKit's own sheet takes the payment                        |
| Sync settings, pairing, devices, iCloud                                     | Rust-direct                           | `direct.sync.*`, the bodies of the `sync_*` commands Settings calls             |
| Editor settings, themes, fonts, AI providers, crash reports                 | Rust-direct                           | `direct.editorSettings.*`, `.fonts.list`, `.ai.*`, `.crashReports.*`            |
| Glass Transparency (this iPhone's own)                                      | Swift's `UserDefaults`                | moved from `src/renderer/src/phone/glassPrefs.ts` in stage 1                    |

- Each Rust-direct entry starts as a refactor: the command's body moves into a function that both the Tauri command and the screens module call, so validation is never written twice.
- Rust's write gate (`src-tauri/src/storage/db.rs`) stays the enforcement for every write, whichever side asked for it.

### Rust-direct operations

`src-tauri/src/screens/direct.rs` maps each `direct.` operation to the body of one Tauri command, its `…_inner` function.

| Area            | Operations                                                                                         | Command bodies                                   |
| --------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Editor settings | `direct.editorSettings.get`, `.set { patch }`                                                      | `editor_settings_get`, `editor_settings_set`     |
| Imported fonts  | `direct.fonts.list`, `.import { path }`                                                            | `fonts_list`, `Fonts::import`                    |
| Crash reports   | `direct.crashReports.get`, `.set { on }`                                                           | `crash_reports_get`, `crash_reports_set`         |
| AI providers    | `direct.ai.get`, `.set { settings }`, `.keySet { provider, key }`, `.keyClear { provider }`        | `ai_settings_get`, `ai_settings_set`, `ai_key_*` |
| Licence         | `direct.licence.get`, `.set { key }`, `.remove`, `.refresh`                                        | `licence_*`                                      |
| App Store       | `direct.store.products`, `.purchase { product }`, `.restore`, `.macKey`, `.refund`                 | `store_*` of the same name                       |
| Sync settings   | `direct.sync.get`, `.set { patch }`, `.devices`, `.usage`, `.deviceRemove { device }`              | the `sync_*` command of the same name            |
| Sync vault      | `direct.sync.vaultCreate { relaySecret }`, `.vaultRotate { relaySecret }`, `.vaultLeave`           | the `sync_vault_*` command of the same name      |
| Recovery key    | `direct.sync.recoveryKey`, `.recoverySaved`, `.joinRecovery { recoveryKey }`                       | the `sync_*` command of the same name            |
| Pairing         | `direct.sync.pairingOpen`, `.pairingCheck`, `.pairingCancel`, `.joinCode { code, via? }`           | the `sync_*` command of the same name            |
| iCloud          | `direct.sync.icloudStatus`, `.icloudUse { recoveryKey? }`, `.icloudLook`, `.icloudJoin { accept }` | the `sync_icloud_*` command of the same name     |
| iCloud vault    | `direct.sync.icloudUploadAgain`, `.icloudRotate`, `.icloudLeave { recoveryKey }`, `.icloudStorage` | the `sync_icloud_*` command of the same name     |

- An operation's name is its command's in camel case, so `direct.sync.icloudUploadAgain` runs the body of `sync_icloud_upload_again`.
- `direct.fonts.import` has no command of its own: the Mac's `font_import` opens its own dialog, while the iPhone's document picker hands Rust a copy, and Rust reads it only inside the app's temporary folder.
- A request's `args` are the command's arguments under the names the page passes them, and unknown fields are refused with `E_SCREENS_ARGS_INVALID` before anything runs.
- Its reply's `result` is what the command answers, and its `code` the command's own refusal code, so Swift and the page see the same outcome for the same input.
- Rust runs the body on its async runtime and answers Swift once, from that thread; a panic there answers `E_SCREENS_INTERNAL`, and a request that comes before the app's services exist is refused with `E_SCREENS_NOT_READY`.
- A Rust-direct request is never queued for the page or counted among the waiting requests, so it works before the page has started.
- A change made this way emits the command's own events (`devot://editor-settings-changed`, `devot://licence-changed`, `devot://sync-changed`), so the page follows a change made in native Settings.
- The operations reach the database only through `NoteCounts`, the two counts sync's settings show, so no Rust-direct request can write a note; a test over the operation enum holds every name to a settings area.
- A failure is logged as `W_SCREENS_DIRECT_FAILED op=… id=… code=…`, and a request's arguments, which may hold a licence key, an AI key or a relay secret, are never logged.
- The native purchase sheet reads StoreKit's price with `direct.store.products` and buys with `direct.store.purchase`, the bodies the page's sheet calls, so StoreKit's own sheet takes the payment either way.
- Importing a font joins with the Appearance pane that first sends it.
- The sync engine's commands (`sync_connect`, `sync_pull`, `sync_push`, `sync_disconnect`, `sync_status_report`) stay the core's.

### Keeping lists fresh

- The core sends `notes.changed { rev, ids }` after each write it makes and after it takes in external changes from sync, iCloud or another process.
- It also sends `books.changed`, `tags.changed` and `savedSearches.changed`.
- Swift reads only the changed rows again from Rust and applies them to the list's diffable snapshot, so moves and inserts take the system's list animation.
- When a `rev` is not the next one, Swift reloads the whole first page (200 rows) rather than guess.

### Tabs

Until the lists are native, the Notes, Library and Activity tabs are each a navigation stack with a hidden bar whose root, `WebTabScreen`, holds the web view while its tab is shown, and the page draws that tab's stack.
The Settings tab is native (Settings tree below); the page still follows it with `tabs.show`, sent whenever the tab appears, whatever page is on its top.
The tab bar is the system's, icon-only: each item's image is the web tab bar's symbol and its filled variant when selected, its title is nil, and its name is its VoiceOver label.
UIKit's bar items have no large content title, so the large content viewer shows the symbol alone.
The page keeps its own tab bar and compose circle only when the screens are not installed; under the system bar, New Note is a button in the Notes and Library list capsule.

| Message                                    | From  | Meaning                                                                                         |
| ------------------------------------------ | ----- | ----------------------------------------------------------------------------------------------- |
| `tabs.show { tab }`                        | Swift | a tab appeared: the page shows that tab's stack, as it was, and never pops it                   |
| `tabs.popToRoot { tab }`                   | Swift | the selected tab was tapped again: the page pops that stack to its root                         |
| `tabs.state { tab, barHidden, attention }` | page  | the page's tab, whether the bar should hide, and whether Settings needs the licence's attention |

- `tab` is one of `notes`, `library`, `activity` and `settings`; anything else is `E_SCREENS_ARGS_INVALID`.
- The page sends `tabs.state` whenever one of its fields changes; it is idempotent, and Swift applies only what differs.
- Swift selects the page's tab when the page changes tab itself (All Notes from the Library, the gate's licence pane), but ignores the page's tab while a `tabs.show` is unanswered, so a stale notice never undoes a tap.
- The bar hides over a note, search or a sheet the page draws over the whole screen, since those cover where the bar sits, and stays over a pushed list or pane.
- Settings shows the web shell's `!` badge while the licence needs attention, with "Needs attention" as its VoiceOver value.
- The web view rests in `WebStage` when a tab's screen disappears, and the next tab's screen takes it, so a tab switch never takes it out of the window.
  The stage hides it from VoiceOver and the accessibility audit, which would otherwise reach the page drawn behind the native Settings.
- `WebTabScreen`'s view reports the window's safe area insets, and the web view derives its own from them: the page lays itself out by `env(safe-area-inset-*)` exactly as without the system bar, and its own room for a floating bar at the bottom clears the system's.
- The view overrides `safeAreaInsets` because the tab bar's inset can reach it through its superview, which a negative `additionalSafeAreaInsets` does not take back (on iOS 26.5 each screen kept the bar's 49 points).
- The bar's tint is `color.accent.text` and it is never minimised on scroll.
  Glass Transparency does not reach it: the floating tab bar ignores a bar tint (spike: bar tint).
- The host-app XCTests check the bar's items, the web view's moves and the key window; the `iphone-ui` CI job's XCUITest (`src-tauri/apple/DevotUITests/Tests/TabsTests.swift`) launches the real app, switches all four tabs by their names and runs the accessibility audit on the bar (docs/specs/quality.md, CI).

## Editor screen protocol

| Message                                     | Direction    | Meaning                                                                                                        |
| ------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------- |
| `editor.prepare { noteId }`                 | Swift → page | a row was pressed: the core opens and holds the note so its bytes are in memory                                |
| `editor.show { noteId, mode, focus }`       | Swift → page | the web view is in an editor screen: swap CodeMirror's state, set Edit or Preview, and focus the body if asked |
| `editor.hide`                               | Swift → page | the web view is back in `WebStage`: the core lets the note go after 30 s                                       |
| `editor.ready { noteId }`                   | page → Swift | the note's first frame is painted                                                                              |
| `editor.title { id, title }`                | page → Swift | the title changed, so the row and the bar's title follow at once                                               |
| `editor.scroll { titleVisible }`            | page → Swift | the page's own title scrolled under the bar, which fades its inline title in                                   |
| `editor.insets { bottom, duration, curve }` | Swift → page | the keyboard moved; the page sets its bottom inset and CodeMirror's scroll margin at once and animates nothing |
| `editor.format { id }`                      | Swift → page | a button on the native formatting bar, by the editor's format ID                                               |
| `editor.gate { what }`                      | page → Swift | a write was tried while writes are locked: Swift opens the gate's sheet                                        |

### The web view never changes size

The web view keeps a width and height equal to the editor screen's content area, the window's bounds, wherever it is.
In `WebStage` it is clipped, not pinned to the stage's edges, and in an editor screen it is pinned to the container's edges, which give the same size.
So a move never changes the page's viewport, and a push never starts with CodeMirror measuring again.
It moves between superviews with `addSubview` alone, never `removeFromSuperview` first, so its window is never nil.

### Row to editor

1. Touch-down highlights the cell and sends `editor.prepare`.
2. Touch-up pushes `EditorScreen` at once; the push is the system's and is never retimed or waited on.
3. In the navigation controller's `willShow`, the editor's container takes the web view under a cover: the theme's background with the title in the note type scale, drawn natively.
   Swift sends `editor.show`.
4. The page swaps the note in under 16 ms and answers `editor.ready`.
5. The cover fades over `motion.duration.phone-adjust` once `editor.ready` arrives, never before the push's first frame.
   Without `editor.ready` after 400 ms the cover fades anyway and the page shows its own loading state.

A note opens in Edit when it is empty and writes are allowed, and in Preview otherwise; while writes are locked every note opens in Preview and stays there.

### Editor to list

- When a pop or an edge swipe starts, nothing moves: the live web view slides out with the leaving editor, still scrolling and still holding its caret and keyboard.
- A cancelled swipe has nothing to undo.
- When the pop completes, the web view moves to `WebStage` with animations off, and Swift sends `editor.hide`.

### Editor to editor

- A link pushes a new `EditorScreen`: the leaving one keeps a snapshot of the web view in its container, and the new one takes the live view under its cover and sends `editor.show`.
- Popping back keeps the live view in the leaving editor while it slides; when the pop completes, the revealed editor takes it under its cover, sends `editor.show` and drops its snapshot.

### New Note

1. New Note is the trailing item of the navigation bar on the Notes root, every notebook's list and Library; a long press offers New Note in a notebook and From Template.
2. On a tap the gate reads Swift's licence snapshot.
   When writes are locked it opens its sheet, plays the warning haptic, and pushes and creates nothing; an unlock from the sheet runs New Note once, after the sheet has gone.
3. Otherwise Swift pushes `EditorScreen` at once with an empty title on the cover, and sends `note.create { bookId }` in the same frame; its reply is followed by `editor.show { noteId, focus: "body" }`.
   The notebook is the one New Note files into on the Mac: the view's notebook, else the default notebook, else none.
4. The snapshot only decides what the screen shows; Rust's write gate decides what is stored.
   If the core answers a licence code, Swift pops the editor while its cover is still up, opens the gate's sheet once the pop completes and reads the licence again; the user sees no code.
5. The keyboard rises after the push has settled, on the system's curve, by the path the keyboard spike chooses.
6. Back from a new note left untouched purges it when its screen leaves the stack, and removes its row without animation before the pop's first frame.

## Glass map

Glass is the system's, on the navigation layer only; content is never glass.

| Surface                                               | Material                                                                                                 | Tint                                                                 | Shape                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------- |
| Navigation bar                                        | the system bar: no background, a scroll-edge effect at the top                                           | none                                                                 | system                                       |
| Bar items (back, More, New Note, Done, close)         | the system's bar item glass; New Note gets a capsule of its own                                          | none; a sheet's one confirm item is prominent in `color.accent.fill` | system capsule                               |
| Tab bar                                               | the system tab bar, never minimised on scroll                                                            | `color.accent.text` on the selected item only                        | system                                       |
| Search tab                                            | the system's search circle                                                                               | none                                                                 | system                                       |
| The editor's bottom toolbar (Back, Forward, Find, AI) | the system toolbar's grouped glass                                                                       | the AI sparkle keeps the caret's colour on its glyph                 | system                                       |
| Formatting bar on the keyboard                        | regular, interactive glass in a glass container with the Hide Keyboard circle, so the two merge and part | none                                                                 | capsule and circle, `size.phone-target` high |
| Undo toast                                            | regular glass, not interactive                                                                           | none                                                                 | capsule of `size.phone-toast`                |
| Sheets                                                | the system's own sheet material; lists inside keep solid `color.phone.card` cells                        | none                                                                 | system, grabber on                           |
| Menus, context menus, alerts                          | system                                                                                                   | none                                                                 | system                                       |
| A content sheet's one primary action                  | the system's prominent glass button                                                                      | `color.accent.fill`, label `color.accent.on-fill`                    | capsule of `size.phone-sheet-done`           |
| Rows, cards, the note, pickers' lists, Settings forms | solid `color.phone.background`, cards `color.phone.card`                                                 |                                                                      |                                              |
| The editor's cover                                    | solid `color.phone.background` with the native title                                                     |                                                                      |                                              |

- Devot's glass never sits on glass and never on content; inside a sheet Devot adds no glass of its own but the one primary action.
- Glass that belongs together shares one glass container with 12 pt spacing: the formatting bar with the Hide Keyboard circle, and the toolbar's Back and Forward with Find.
- Only what a finger presses is interactive glass.
- Colour on glass marks what is selected only: the accent on the selected tab, the caret's colour on the AI sparkle.
- Devot's two glass views (the formatting bar and the toast) cast `shadow.phone-float-*` in `color.phone.float-shadow`, drawn from a shadow path so no offscreen pass runs.
- Glass Transparency runs from −100 to 100 in steps of 5 and is this iPhone's own setting, never synced:
  - on Devot's two glass views, −100 is a solid `color.phone.glass-opaque`, values below 0 tint regular glass with it at −t/100, 0 is plain regular glass, and values above 0 are clear glass tinted at the larger of 0 and 0.25 − t/400;
  - on the system bars, whose glass has no public opacity, only values below 0 act: a background of `color.phone.glass-opaque` at −t/100 × 0.85, and from 0 up the system's default;
  - a change applies on every move of the slider and is saved when the finger lifts.
- Reduce Transparency and Increase Contrast win over Glass Transparency: the system frosts its glass, Devot's glass views follow with a solid fill, and the slider shows disabled with a footer that says why.

## Settings tree

Every pane is a SwiftUI form in a hosting controller pushed on the Settings tab's own navigation controller, so push, pop and the edge swipe are UIKit's.
The root's rows are buttons that push through `SettingsRouter`, never SwiftUI navigation links, since no SwiftUI navigation container holds them.
Appearance and Sync are still the page's panes: their rows push a `WebPaneScreen`, which asks the page for the pane with `settings.showPane` each time it shows and takes the web view under the native bar once the page answers, so the push never shows what the page drew before.
The web view keeps its size there; its safe area takes in the bar, so the page's top inset clears it.
The page keeps a pane it still shows when asked again, so a tab switch loses nothing typed in it and leaves a pairing running; once the `WebPaneScreen` leaves the stack, Swift sends `tabs.popToRoot { tab: "settings" }` and the page lets the pane go, as its own Back did.
Rows have a label, at most one short description and one trailing edge (a value with a chevron, a switch, or nothing), with no info buttons.
A choice of three or fewer sits inline as checkmark rows, and a longer one pushes a checkmark page.
Every choice applies in the next frame with no transition, before it is saved.

```
Settings root (large title, the system search field, a Pair a Device bar button → Sync, at pairing)
├─ App row: Devot, "version · licence", a badge when the licence needs attention → License (the Trial sheet while a trial runs)
├─ General
│  ├─ General → Default Notebook (picker: None, then notebooks in Library order); Send Crash Reports (where reports can be sent)
│  ├─ Appearance → Color Scheme, Theme, Gradient (only for a gradient theme), Glass, Text, Note Font, Animations
│  ├─ Editing → today's phone rows; Cursor Scroll Margin, Tab Width and Line Height push checkmark pages
│  └─ Preview → Load Images from the Web
├─ Sync & Storage
│  └─ Sync (On or Off, a badge when sync needs the owner) → relay, status, setup, iCloud, usage, Devices, pairing
├─ AI & Integrations
│  └─ AI → the licence notice when locked, Provider, endpoint, model and key, Suggest on Idle
├─ (no header)
│  ├─ License (its label, a badge when it needs attention) → status, its one action, trial, devices, licensee, ID, key, Remove
│  ├─ Restore Purchases (App Store builds)
│  ├─ Get a Mac License Key (App Store builds, Pro held) → the Mac key sheet
│  └─ Request a Refund (App Store builds, Pro held)
└─ Footer: Devot and its version
```

- Appearance holds three colour scheme cards, a two-column grid of themes with "Aa" swatches for light and dark, a Glass card whose sample previews Glass Transparency, a Text card with a live sample above the Text Size and Preview Font Size sliders, a Note Font row and an inline Animations choice.
- Gradient is a card under the themes, so choosing one moves nothing above it, shown only while the Light or Dark theme is Dawn, Tide, Sage or Ember, and gone at once when neither is.
  It holds one slider labelled Gradient, from Solid (0) to Full (100) in steps of 5, with no description and a 44 pt target.
  It reads and writes the `gradientStrength` editor setting through Rust (default 0), one value for every gradient theme, so it is kept on this device and never synced, like the theme choice.
  Wherever the shell draws a theme's `Backdrop`, each stop is mixed in sRGB towards the gradient's middle colour (its stop at 0.5) by strength / 100: 0 is that colour alone, 100 the stops as designed.
  A change applies on every move of the slider and is saved when the finger lifts, as Glass Transparency is.
- App Font is not on the phone.
- The panes read their snapshots (editor settings, crash reports, licence, AI, sync) through Rust-direct operations each time the root shows, and Default Notebook's choices from the page with `settings.notebooks`, so a pushed page never waits for a first read.
- A change applies to the snapshot first and then goes to Rust; Rust's newer snapshot replaces it, an older one never does, and a refused write puts the old value back, raises the `appearanceSettings.failed` alert and logs `W_PHONE_SETTINGS_SAVE_FAILED key=… code=…`.
- Pair a Device pushes Sync with the `pairing` anchor: the page opens the pane afresh and scrolls to its pairing card (or, before this device is in a vault, its setup rows) once drawn, unless the owner touches the pane first; the anchor goes with the push only, so coming back to the tab leaves the pane where it was.
- `SettingsRouter.open` sets the stack to the root and the page in one `setViewControllers`, so Back lands on the root; it animates only while the app is in front.
- Enter License Key in the page's Pro sheet sends the `settings.open { pane: "licence", focusKey }` notice, and Swift opens License over the root with its key field focused once the push lands.

| Message                               | From  | Meaning                                                                                                             |
| ------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------- |
| `settings.showPane { pane, anchor? }` | Swift | the page shows `appearance` or `sync` in the web view, without its own bar; `anchor` is only `pairing`, with `sync` |
| `settings.notebooks`                  | Swift | the page answers the notebooks, each with `id`, `name` and `depth`, in order                                        |
| `settings.open { pane, focusKey }`    | page  | the page asks Swift to open License, its key field focused or not                                                   |

- Settings search runs `settings/search.ts`'s matching in Swift over `Generated/SettingsIndex.swift`, which `pnpm i18n:apple` writes from the same entries; `tests/fixtures/settings-search.json` holds what the page finds for a set of queries, and both suites check it.
- A purchase on the License page goes through StoreKit only, never a link outside it (ADR 0014).
- Settings text comes from the message catalog by key, as everywhere else.

## Spikes

These are measured on a device in stage 0, before the stages that depend on them start; each result is written here.

### The harness

- A debug build carries a spike harness, `Sources/DevotScreens/Debug/` in the package and `src/renderer/src/phone/screens/spikes.ts` in the page; a release build carries neither.
- The launch argument `-DevotSpike S1|S2|S3|S4|barTint` starts one spike once the screens are installed and the page answers a ping; without it the harness does nothing.
- The harness drives the page's probes through `WKWebView.callAsyncJavaScript` on `window.__devotSpikes`, the one exception to Swift never talking to the page directly, and it exists in debug builds only.
- Each run writes `Documents/spikes/<spike>.json` in the app's container, shaped `{ spike, device, os, build, startedAt, results, pass, notes }`.
- `device` is the model identifier, never the phone's name, and `pass` is `null` when the result is read off a screenshot.
- A run that cannot finish writes `pass: false` with its error code as the only note, such as `E_SPIKE_PAGE_TIMEOUT` when the page never answers within 60 s.
- Each run logs `I_SPIKE_START spike=<spike>` and `I_SPIKE_DONE spike=<spike> pass=<pass>` through `os_log`, subsystem `io.github.jma49.devot`, category `spikes`.
- To run one, install a debug build on a connected iPhone and run `scripts/ios/run-spike.sh <spike> [device]`.
- The script builds, signs and installs nothing and needs no secret: it launches the app with `xcrun devicectl`, waits for a report whose `startedAt` differs from the one left before the launch, copies it back with `xcrun devicectl device copy from` and prints it.
- `E_SPIKE_REPORT_TIMEOUT` from the script can mean the installed app was built without the harness, as when Xcode builds the package in its release configuration for the app's debug one; CI checks the package alone, not the app's build of it.
- CI builds the package in Debug and Release and fails with `E_SPIKES_IN_RELEASE` when a Release symbol names a spike (`scripts/ci/devot-screens-release-check.sh`).
- The page's probes load only when `DEVOT_SPIKES` is true, which Vite sets for a Tauri debug build, and `scripts/sentry/ui.ts` fails a release build whose bundle holds `__devotSpikes`.

### Each spike

- **S1, reparenting.** The web view moves to a native screen and back 200 times during a sync, `visibilityState` stays `visible`, the core worker answers a ping every 100 ms, and Tauri never resizes the moved view.
  The harness moves the web view between the root and a pushed screen with `addSubview` alone and checks its size after each move and again 50 ms later.
  The page counts `visibilitychange` to hidden, viewport resizes, unanswered or late pings, and the sync states it saw, and it touches sync while the moves run.
  Pass: no size change, no hidden page, no missed ping and no resize.
  A run in which sync never reached `syncing` says so in its notes, so turn sync on and write on another device while it runs.
  Run: `scripts/ios/run-spike.sh S1`.
  Result (2026-11-07, iPhone18,2, iOS 27.2, debug build): passed with sync off; 200 moves, no size change, no hidden page, no viewport resize, 205 pings answered with none missed and a longest gap of 108 ms.
  Sync was not running, so the run under sync is still to be taken.
- **S2, the keyboard after a native tap.** On iOS 26 and 27, a hidden native text field made first responder in `viewDidAppear` hands focus to the page; a public path is preferred.
  Otherwise the numbers choose between a guarded private focus path with a fallback, and a caret with no keyboard until the first tap.
  The harness tries four paths on a pushed screen: the field holds the keyboard and the page focuses its editor, the same followed by making the web view first responder, the web view made first responder before the page focuses its editor, and the page focusing its editor with no keyboard up.
  Each try records whether the keyboard came up and stayed up, which view is first responder, and whether the page's editor has focus and shows a caret.
  The harness waits for the scene to be foreground-active first; if the field leaves the keyboard down, it makes the window key when it is not, then has the field resign and become first responder again, and records each step.
  `results.diagnostics` records, after each step and around each try, the window's and the scene's key and activation state, the first responder's class, the field's state, a hardware keyboard, and the keyboard, window and scene notifications with their times.
  Pass: either hand-off keeps the keyboard up with the web view first responder and the caret in the editor.
  The guarded private focus path is not built; it is built and measured only if no public path passes.
  Run: `scripts/ios/run-spike.sh S2`.
  Result (2026-11-07, iPhone18,2, iOS 27.2): a public path passes once tao's window is key.
  The app's window is not its scene's key window after launch: the scene has no key window, so a field that is first responder raises no keyboard until a tap or `makeKey()` makes the window key.
  This comes from tao attaching its window to the scene after `makeKeyAndVisible`, as the app declares no scene manifest; the native shell must make that window key when it installs (PR 12).
  With the window key, the field raises the keyboard at once.
  The field holding the keyboard while the page focuses its editor keeps the keyboard up but gives the editor no focus, since the web view is not first responder.
  Making the web view first responder after the page focuses its editor gives a caret but drops the keyboard.
  Making the web view first responder while the field holds the keyboard, then focusing the editor, ends with the keyboard up, the web view first responder and the caret in the editor; the keyboard hides and shows again within about 25 ms on the way.
  The page focusing its editor with no keyboard up gives neither focus nor a caret.
  So the native shell takes that last public order (D2), checks by eye in PR 17 that the quick hide and show is not seen, and needs no private focus path.
  Under iPhone Mirroring the phone uses the Mac's keyboard and shows none, so this spike is run with the phone in hand.
- **S3, the bridge.** 1000 no-operation round trips stay within p50 4 ms and p95 10 ms, and 60 excerpt calls while a list scrolls at 120 Hz drop no frames.
  The round trips go Swift to Rust to the page and back, the way every real request goes, and are timed in Swift.
  The 60 excerpt calls of 20 notes each go 50 ms apart while the page scrolls a 3000-row list, and the page counts frames longer than 1.5 times the screen's frame budget.
  Until the page handles excerpts it refuses them with `E_SCREENS_OP_UNSUPPORTED`, so the calls time the bridge and not the core, and the report says so.
  Pass: no failed round trip, p50 at most 4 ms, p95 at most 10 ms, and no frame over budget.
  Instruments' Hitches on the device is the authority on dropped frames, and it is read by hand during the run.
  Run: `scripts/ios/run-spike.sh S3`.
  Result (2026-11-07, iPhone18,2, iOS 27.2): the bridge passed; 1000 round trips with none failed, p50 0.27 ms, p95 0.43 ms, longest 4.9 ms.
  The 60 excerpt calls were refused as expected and timed the bridge at p50 3.53 ms and p95 4.78 ms.
  WebKit runs the page's animation frames at 60 Hz on a 120 Hz screen, so the page's frame count measures against 16.7 ms, not 8.3 ms: over 217 frames the longest was 18 ms and none passed 1.5 times 16.7 ms.
  Instruments' Hitches was not read in this run.
- **S4, the page as its own scroller.** CodeMirror with an auto-height editor and a visible scroller lets the web view's own scroll view scroll the note; layout, selection handles, the bar's scroll-edge effect and interactive keyboard dismissal hold on iOS 26.
  If it holds, the page scrolls itself; otherwise CodeMirror's own scroller stays.
  The harness shows a long made-up note in a navigation controller with a toolbar, sets the web view's scroll view as the bar's content scroll view with interactive keyboard dismissal, and scrolls it to the middle and to the end.
  Pass: the scroll view scrolls, its content height matches the page's height within 2 points, the page's scroll position matches the offset at the middle, and the page has drawn lines at both stops.
  The screen stays up, and selection handles and the scroll-edge effect are read off a screenshot taken by hand.
  Run: `scripts/ios/run-spike.sh S4`.
  Result (2026-11-07, iPhone18,2, iOS 27.2): passed; the scroll view's content height equals the page's 27481 points, the offsets at the middle and the end match the page's scroll position, and lines are drawn at both stops.
  By hand: the note scrolls from its first line to its last, a long press selects a word with both handles, dragging the handles works, a tap raises the keyboard, and the bar's scroll-edge effect blurs the lines under it.
  So the page scrolls itself.
- **Bar tint.** A background colour on the navigation bar, toolbar and tab bar appearances draws behind iOS 26's floating bars, as Glass Transparency below 0 needs.
  If the floating tab bar ignores it, the tint reaches the navigation bars and the toolbar only.
  The harness shows a tab bar around a navigation controller with large titles, a toolbar and a long list, with `phoneActionTrash` at half opacity on all three appearances.
  The screen stays up, and which bars draw the tint is read off a screenshot taken by hand, so the report's `pass` is `null`.
  Run: `scripts/ios/run-spike.sh barTint`.
  Result (2026-11-07, iPhone18,2, iOS 27.2): only the navigation bar draws the tint, and it then draws as an opaque band instead of floating glass; the floating tab bar and the toolbar ignore it.
  So Glass Transparency below 0 cannot reach the bars through their appearance's background colour, and the tint needs another path in PR 14.
  iOS 26 was not measured.
