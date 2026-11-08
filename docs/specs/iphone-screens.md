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
               ├─ Activity  UINavigationController → Activity → EditorScreen
               ├─ Settings  UINavigationController → Settings root → panes
               └─ Search    UISearchTab → UINavigationController → Search (scopes All and Titles) → EditorScreen
            sheets: the system's sheet presentation   menus: UIMenu and context menus
```

- **Swift.** The `DevotScreens` package sits beside `src-tauri/apple/DevotStore` and is linked the same way.
  `Bridge.swift` holds the C ABI and is its only file with `Unsafe*Pointer`.
  `Model/` holds the Codable messages, the routes (`Route.swift`) and the restoration record (`Restoration.swift`), pure logic tested without UIKit.
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
4. On `false` the app keeps the web fallback.
   Swift answers `false` when the kill switch is on or when an object is of another class, and logs why with a code.
5. At start the page calls `screens_take`, which answers `{ installed, pending }`: whether the screens attached, and the operations queued before the page listened.
6. With `installed` the page mounts the editor host alone (no tab bar, lists, sheets or glass); otherwise it mounts the web fallback.
   Both paths start the core and seed the welcome notes the same way.
7. The web fallback draws no tab bar, note list, Library, search or toast, which are all native: it opens on Activity, whose ranked notes open the page's note screen, and its Settings only from the Devot Pro prompt's License button.
   That note screen keeps Back, the mode toggle and the chips' web pickers, and has none of the editor's bars, find or Note Info, which are native.
   UI tests reach its other screens through `globalThis.devotPhone` (`showTab`, `openNote`, `notes`), which the page installs only in a `DEVOT_UI_TEST` build.

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
- A core operation that reaches the page while its core is still starting waits for the core and the first read of the lists; once the core failed to start, the page refuses it with `E_SCREENS_UNAVAILABLE`.
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
  - a title is at most `MAX_TITLE_CHARS`, a tag name at most the tag limit, and a search query at most as long as 10 clauses of 100 characters a term (the core reads no further, so Rust checks only that length, not the clauses);
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
| Activity's heatmap, week figures and most edited notes                      | core                                  | `writing(now)`, which also builds the Mac's Activity                            |
| History, AI edits, import, export                                           | core, drawn in the page until stage 4 | as today                                                                        |
| Licence state and the gate                                                  | Rust-direct                           | `direct.licence.*`, the bodies of the `licence_*` commands                      |
| Purchases, restoring them, the Mac key                                      | Rust-direct                           | `direct.store.*`; StoreKit's own sheet takes the payment                        |
| Sync settings, pairing, devices, iCloud                                     | Rust-direct                           | `direct.sync.*`, the bodies of the `sync_*` commands Settings calls             |
| Editor settings, themes, fonts, AI providers, crash reports                 | Rust-direct                           | `direct.editorSettings.*`, `.fonts.list`, `.ai.*`, `.crashReports.*`            |
| Glass Transparency (this iPhone's own)                                      | Swift's `UserDefaults`                | `devot.phone.glassTransparency`; the page's old value moves over once           |

- Each Rust-direct entry starts as a refactor: the command's body moves into a function that both the Tauri command and the screens module call, so validation is never written twice.
- Rust's write gate (`src-tauri/src/storage/db.rs`) stays the enforcement for every write, whichever side asked for it.

### Rust-direct operations

`src-tauri/src/screens/direct.rs` maps each `direct.` operation to the body of one Tauri command, its `…_inner` function.

| Area            | Operations                                                                                         | Command bodies                                      |
| --------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Editor settings | `direct.editorSettings.get`, `.set { patch }`                                                      | `editor_settings_get`, `editor_settings_set`        |
| Imported fonts  | `direct.fonts.list`, `.import { path }`                                                            | `fonts_list`, `Fonts::import`                       |
| Crash reports   | `direct.crashReports.get`, `.set { on }`                                                           | `crash_reports_get`, `crash_reports_set`            |
| AI providers    | `direct.ai.get`, `.set { settings }`, `.keySet { provider, key }`, `.keyClear { provider }`        | `ai_settings_get`, `ai_settings_set`, `ai_key_*`    |
| Licence         | `direct.licence.get`, `.set { key }`, `.remove`, `.refresh`                                        | `licence_*`                                         |
| App Store       | `direct.store.products`, `.purchase { product }`, `.restore`, `.macKey`, `.refund`                 | `store_*` of the same name                          |
| Sync settings   | `direct.sync.get`, `.set { patch }`, `.devices`, `.usage`, `.deviceRemove { device }`              | the `sync_*` command of the same name               |
| Sync vault      | `direct.sync.vaultCreate { relaySecret }`, `.vaultRotate { relaySecret }`, `.vaultLeave`           | the `sync_vault_*` command of the same name         |
| Recovery key    | `direct.sync.recoveryKey`, `.recoverySaved`, `.joinRecovery { recoveryKey }`                       | the `sync_*` command of the same name               |
| Pairing         | `direct.sync.pairingOpen`, `.pairingCheck`, `.pairingCancel`, `.joinCode { code, via? }`           | the `sync_*` command of the same name               |
| iCloud          | `direct.sync.icloudStatus`, `.icloudUse { recoveryKey? }`, `.icloudLook`, `.icloudJoin { accept }` | the `sync_icloud_*` command of the same name        |
| iCloud vault    | `direct.sync.icloudUploadAgain`, `.icloudRotate`, `.icloudLeave { recoveryKey }`, `.icloudStorage` | the `sync_icloud_*` command of the same name        |
| Native lists    | `direct.lists.notes { view, status, offset, limit }`, `.library`, `.trash`, `.titles { ids }`      | the `Store` reads of the list commands (`lists.rs`) |

- An operation's name is its command's in camel case, so `direct.sync.icloudUploadAgain` runs the body of `sync_icloud_upload_again`.
- `direct.fonts.import` has no command of its own: the Mac's `font_import` opens its own dialog, while the iPhone's document picker hands Rust a copy, and Rust reads it only inside the app's temporary folder.
- A request's `args` are the command's arguments under the names the page passes them, and unknown fields are refused with `E_SCREENS_ARGS_INVALID` before anything runs.
- Its reply's `result` is what the command answers, and its `code` the command's own refusal code, so Swift and the page see the same outcome for the same input.
- Rust runs the body on its async runtime and answers Swift once, from that thread; a panic there answers `E_SCREENS_INTERNAL`, and a request that comes before the app's services exist is refused with `E_SCREENS_NOT_READY`.
- A Rust-direct request is never queued for the page or counted among the waiting requests, so it works before the page has started.
- A change made this way emits the command's own events (`devot://editor-settings-changed`, `devot://licence-changed`, `devot://sync-changed`), so the page follows a change made in native Settings.
- The settings operations reach the database only through `NoteCounts`, the two counts sync's settings show, and the list reads (`src-tauri/src/screens/lists.rs`) only through a lent `&Store`, so no Rust-direct request can write a note; a test over the operation enum holds every name to a settings area or the lists.
- `direct.lists.notes` takes a `view` (`all`, `pinned`, `book { id }`, `tag { id }`, `templates`), a `status` filter (`all`, `active`, `on_hold`, `completed`) and a page (`offset`, `limit` of at most 1,000), and answers `{ rows, total }` newest first (`updatedAt`, then `id`, descending), the order Swift keeps.
  A row is the note's title, dates, notebook, status, pinned flag, tag IDs and body version; a notebook's list takes in its notebooks' notes, and only Templates lists the templates notebook.
- `direct.lists.library` answers the smart lists' counts (all, pinned, active, on hold, completed, templates, trash), the notebooks in the Library's order (each after its parent) with their counts, the tags with their colours and counts, and the saved searches.
- `direct.lists.trash` answers the trashed notes, last trashed first.
- `direct.lists.titles { ids }` takes at most 16 note IDs and answers `[{ id, title }]` for those that are live notes, in the order asked; a note in the Trash or gone has no row.
  Swift reads it before it shows a linked or restored editor, so it never opens a note that has gone.
- `tests/fixtures/screens/rows.json` holds one reply of each, which Rust checks its replies against by shape and Swift decodes.
- A failure is logged as `W_SCREENS_DIRECT_FAILED op=… id=… code=…`, and a request's arguments, which may hold a licence key, an AI key or a relay secret, are never logged.
- The native purchase sheet reads StoreKit's price with `direct.store.products` and buys with `direct.store.purchase`, the bodies the page's sheet calls, so StoreKit's own sheet takes the payment either way.
- `direct.fonts.import { path }` imports the copy the document picker made, and takes only a file under the app's temporary folder.
- The sync engine's commands (`sync_connect`, `sync_pull`, `sync_push`, `sync_disconnect`, `sync_status_report`) stay the core's.

### Keeping lists fresh

- The core sends `notes.changed { rev, ids }` after each write it makes and after it takes in external changes from sync, iCloud or another process.
- It also sends `books.changed`, `tags.changed` and `savedSearches.changed`.
- Swift reads only the changed rows again from Rust and applies them to the list's diffable snapshot, so moves and inserts take the system's list animation.
- When a `rev` is not the next one, Swift reads every row the list has loaded again (at least the first page of 200) rather than guess, so the list keeps its length and scroll position.
- `notes.changed { rev, ids, all: true }` says the page cannot name the notes (a sync or a launch took in changes), and Swift reads the loaded rows again too.
- The page reports the writes a note save does not (a note's tags, a purge, and notebooks, tags and saved searches) a moment after they complete (`phone/screens/feed.ts`).
- Seeding the first-launch notes sends `notes.changed { all: true }`, since a list may have read the empty library before them.

### Lists

The Notes and Library tabs' roots and every list they push are native (`DevotScreens/UI/Lists/`).

| Message                                  | From  | Meaning                                                                                      |
| ---------------------------------------- | ----- | -------------------------------------------------------------------------------------------- |
| `excerpts { ids }`                       | Swift | at most 60 IDs; answers `{ excerpts: { id: text } }`, and a note with no excerpt is left out |
| `notes.batch { ids, change }`            | Swift | one change to several notes; answers `{ changed, failed: [{ id, code }] }`                   |
| `trash.empty`                            | Swift | purges the Trash; answers `{ purged }`                                                       |
| `book.create`                            | Swift | makes a notebook named New Notebook at the top level; answers `{ id }`                       |
| `template.create`                        | Swift | makes an empty template; answers `{ id }`, which Swift opens                                 |
| `template.apply { templateId, bookId? }` | Swift | makes a note from a template; answers `{ id }`, which Swift opens                            |
| `note.text { noteId }`                   | Swift | the note's title and Markdown, for the share sheet                                           |
| `note.complete { noteId }`               | Swift | sets the status to completed; answers `{ undo }`, what `note.undoStatus` needs               |
| `note.undoStatus { noteId, undo }`       | Swift | puts the status and the update time back, unless the note was written again since            |

- A `change` is one of `book { bookId }`, `status { status }`, `pinned { pinned }`, `putTag { tagId }`, `removeTag { tagId }`, `trash`, `restore` and `purge`.
- `NoteListDataSource` is one list's feed: it reads the first page when its screen loads, and a list nobody has shown reads nothing.
  On `notes.changed` it reads again as many rows as it shows (at least 200, at most 1,000), and redraws only the rows that changed or that the notice names; a row whose place changed moves.
  Reads are one at a time: a change while one is out is read once after it, together with any others.
  The list asks for the next page within 40 rows of its end.
  Sections are Pinned, Recent and Completed as `design/phone.md` describes, and Templates and Trash are one section.
- `ExcerptCache` asks for the excerpts of the rows on screen and a screen ahead, at most 60 IDs a call, never one it holds or is asking for, and keeps them by note ID and body version, so an edit asks again.
  A failed call is logged as `W_PHONE_EXCERPTS_FAILED code=…` and asked again when the rows next show.
- `ListContext` holds what the lists share: the bridge, the gate, the excerpts and the Library's last read, which it reads again on a change once a screen has asked for it.
- Every list write goes through the gate (`notes.batch`, `trash.empty`, `book.create`, `template.create`, `template.apply` are write intents); a swipe answers the system with whether it ran before the gate raises its sheet, and a context menu's write runs once the menu has gone.
  A batch entry refused for the licence raises the sheet; any other failure is logged as `W_PHONE_BATCH_FAILED count=… code=…` or `W_PHONE_LIST_WRITE_FAILED op=… code=…`.
- The undo toast (`UI/Toast.swift`) is offered to `ListContext.undoToasts` by the one write that can be taken back: one note trashed (Undo restores it) or completed by its swipe (Undo sends `note.undoStatus` with the `undo` that `note.complete` answered).
  The page keeps no undo of its own: it answers a completion with `StatusUndo` (`status`, `updatedAt`, `statusHlc`, `bodyVersion`), which Rust checks and Swift holds for the toast.
  A second action replaces the words in place and the first stays done; a trash of several notes, a refused one and a restore offer nothing.
- The toast is a `UIVisualEffectView` of regular, non-interactive `UIGlassEffect` over a `FloatShadowView`, `size.phone-toast` high between the `size.phone-screen-edge` keylines.
  Its bottom is `size.phone-toast-gap` above the tab bar's top edge (`DevotTabBarController` tells the presenter), and never below the safe area or under `keyboardLayoutGuide`.
  The glass is put on after the rise, because UIKit may not install it on a moving host.
- `SettleAnimator` runs `phone-settle` from the release position and velocity on a `CADisplayLink` at 80 to 120 Hz and stops at the first crossing of the target, because the system springs overshoot; it sets `transform` only.
  `ToastModel` holds the rules without UIKit: the pan begins after about 10 pt sideways and fails past 12 pt vertical, the toast goes past 0.25 of its width or faster than 800 pt/s in the direction of the drag, and flies to plus or minus its width + 24 at max(finger speed, distance / 0.16 s).
- VoiceOver announces the message and the toast stays while its focus is on it; Reduce Motion replaces the rise with a 200 ms crossfade in place, and the drag still works.
- A failed read is logged as `W_PHONE_LIST_READ_FAILED`, `W_PHONE_LIBRARY_READ_FAILED` or `W_PHONE_TRASH_READ_FAILED` with its code, and the list keeps what it showed.

### Search

The Search tab is a navigation stack under a large title whose root, `SearchScreen`, holds the system search field with the scopes All and Titles over a native list.

| Message                   | From  | Meaning                                                                            |
| ------------------------- | ----- | ---------------------------------------------------------------------------------- |
| `search { query, scope }` | Swift | searches through the core with its pending edits saved; answers `{ rows, capped }` |

- `scope` is `all` or `titles`; Titles rewrites each plain word as a `title:` clause on the page (`phone/screens/search.ts`), so the core's syntax is parsed in one place.
- Rust refuses a query past the limit above (Message envelope) with `E_SCREENS_QUERY_TOO_LONG`, since the core cuts a long query rather than failing on it.
- A row is a list row with the excerpt the core cut around the first word found, when it found one in the body; `ExcerptCache` asks for the rest.
- `SearchModel` searches once typing pauses for 120 ms, and at once for a scope, a recent search or a suggestion; results replace the list when they arrive, and an answer to an older search is dropped.
- A query that differs only in its outer spaces is not searched again, and an empty field shows the start at once.
- A `notes.changed` notice searches the shown query again after the same pause.
- A failed search is logged as `W_PHONE_SEARCH_FAILED code=…` and takes away the results shown, which answered an older query.
- `SearchModel` cuts the typed text to that limit, counted in Unicode scalars as Rust counts, so a long query is searched as the core would cut it rather than refused.
- Before a query the list shows this iPhone's recent searches, then the notebooks, statuses and tags, each filling the field with its clause (by name where quoting holds the name, else `bookId:` or `tagId:`) and searching.
- Recent searches are the six newest queries whose result was opened, kept in `UserDefaults` and never synced or logged.
- A result opens its `EditorScreen` on the Search tab, so Back lands in Search with the query and results as they were.
- A saved search in the Library opens the Search tab at its root and runs its query under All without raising the keyboard, which rises again the next time the Search tab is chosen.

### Activity

The Activity tab's root, `ActivityScreen` (`DevotScreens/UI/Activity/`), is an inset grouped list of three sections: the heatmap, the chosen week's figures and that week's most edited notes.

| Message            | From  | Meaning                                                                            |
| ------------------ | ----- | ---------------------------------------------------------------------------------- |
| `activity.writing` | Swift | the core's `writing(now)`; answers `{ first, today, days, weeks: { this, last } }` |

- `days` lists the days with writing, each `{ day, words, level }`, numbered as whole days since 1970 on the person's own calendar; `first` is the Monday fourteen weeks before this week's.
- Each week is `{ words, streak, notesEdited, ranked }`, and `ranked` holds at most four `{ id, title, words }`, the page's display title, leaving out notes the page no longer lists.
- `ActivityWriting` (`Model/ActivityModel.swift`) refuses an answer whose span passes fifteen weeks, whose day falls outside it or whose level passes the darkest shade, and logs it as `W_PHONE_ACTIVITY_READ_FAILED code=E_SCREENS_MESSAGE_INVALID`.
- The heatmap is fifteen columns of seven days from Monday, shaded by the `color.activity.level-*` tokens, with the month names `monthLabels` gives on the Mac; days after today are left blank, and VoiceOver reads one summary of the words and active days.
- A segmented control chooses This Week or Last Week, and the figures and the ranked notes replace at once from the same answer, with no new request.
- Every row is UIKit: the grid and its month names are drawn as one picture, the other text follows Dynamic Type from caption 1 up (caption 2 keeps one size below the default), and the segmented control keeps the system's own size and fonts, which the accessibility audit (`ActivityTests`) accepts.
- A ranked note opens its `EditorScreen` on the Activity tab, as a list's row does.
- The screen reads when it appears after a `notes.changed` notice, and at once while it is shown; reads are one at a time, and a failed one is logged as `W_PHONE_ACTIVITY_READ_FAILED code=…` and tried again when the screen next appears.
- The web fallback keeps its own Activity.

### Tabs

The Notes and Library tabs are navigation stacks with the system bar and large titles over native lists (Lists above).
The Activity tab is a navigation stack under a large title over the native Activity (below).
A list that appears asks the page to let the shown note go.
The Settings tab is native (Settings tree below); the page still follows it with `tabs.show`, sent whenever the tab appears, whatever page is on its top.
The tab bar is the system's in tab mode (`UITab`), icon-only: each tab's image is the web tab bar's symbol and its filled variant when selected (iOS 26.1 and later), its title is empty, and its name is its VoiceOver label.
The system's search tab (`UISearchTab`) follows the four, drawn as the system's search circle, and raises the keyboard when it is chosen.
The page has no Search tab: Swift never sends `tabs.show` for it, a reselect pops nothing, and a `tabs.state` naming the page's own tab does not take the bar away from Search unless the page moved to another tab.
UIKit's bar items have no large content title, so the large content viewer shows the symbol alone.
The page keeps its own tab bar and compose circle only when the screens are not installed; under the system bar, New Note is the compose button in the Notes and Library lists' bar.

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
- Every tab's root is native, so the web view rests in `WebStage` unless an editor screen holds it; a tab switch or a pop to a list moves it to the stage without taking it out of the window.
  The stage hides it from VoiceOver and the accessibility audit, which would otherwise reach the page drawn behind the native Settings.
- A `WebHolderScreen`'s view (an editor screen's) reports the window's safe area insets, and the web view derives its own from them: the page lays itself out by `env(safe-area-inset-*)` exactly as without the system bar, and its own room for a floating bar at the bottom clears the system's.
- The view overrides `safeAreaInsets` because the tab bar's inset can reach it through its superview, which a negative `additionalSafeAreaInsets` does not take back (on iOS 26.5 each screen kept the bar's 49 points).
- The bar's tint is `color.accent.text` and it is never minimised on scroll.
  Glass Transparency reaches it only below 0, through the scroll edge effect (spike: bar tint).
- The host-app XCTests check the bar's items, the web view's moves and the key window; the `iphone-ui` CI job's XCUITest (`src-tauri/apple/DevotUITests/Tests/TabsTests.swift`) launches the real app, switches all four tabs by their names and runs the accessibility audit on the bar (docs/specs/quality.md, CI).

### Routes

A `devot://` link reaches the iPhone's native screens as a route: Rust parses and checks the link as on the Mac (docs/specs/security.md, URL scheme), maps it to a route (`src-tauri/src/screens/route.rs`) and sends it to Swift as the `route` notice, which only Rust sends.
A route names screens by kind and ID only, and Swift builds them.

| Link                                        | Route                                                                   | Swift shows                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `devot://note/<id>`                         | `{ route: "stack", tab: "notes", stack: [{ kind: "editor", noteId }] }` | the Notes tab with the note's editor over its list                     |
| `devot://today`                             | `{ route: "today" }`                                                    | asks the page (`note.today`), then shows that note as a note link does |
| `devot://license?key=…`                     | `{ route: "licence", prefill }`                                         | Settings > License with the key in its field, waiting for Add          |
| `devot://command/view.allNotes`             | `{ route: "stack", tab: "notes", stack: [] }`                           | the Notes tab at its root                                              |
| `devot://command/view.trash`                | `{ route: "stack", tab: "library", stack: [{ kind: "trash" }] }`        | the Trash over the Library                                             |
| `devot://command/view.edit`, `view.preview` | `{ route: "mode", mode }`                                               | the shown note's mode; nothing when no note is on top                  |

- Every other command, an import and a note link whose ID is not a canonical UUIDv7 have no route: Rust logs `I_SCREENS_LINK_UNROUTED` and Swift hears nothing.
- `devot://license?key=` only fills the License page's field and is never submitted: the owner's Add submits it, as a typed key.
  A key that failed Rust's check routes with `prefill: null`, so the page opens empty.
- A link never passes the Pro gate: a route only shows screens, and `note.today` makes today's note only while editing is allowed (`openTodaysNote` with `create` set to the page's licence snapshot), else answers `E_LICENCE_REQUIRED`, which Swift logs as `W_PHONE_WRITE_LOCKED op=note.today code=…` and hands to the gate's sheet.
  Today's note that exists already opens while editing is locked, since reading is free.
- A stack route reads `direct.lists.titles` for its editors first; a note no longer live ends the stack below it (`I_SCREENS_ROUTE_NOTE_GONE`), so the tab opens at its root.
- Swift sets the tab's stack with `setViewControllers(_:animated:)`, keeping the screens already in place that the route names, then selects the tab; the change is animated only while the app is in front (`UIApplication.applicationState == .active`), so a link that launches or wakes the app shows its screen in the first frame.
- A sheet over the tabs closes for a stack route, except the gate's own.
- Links wait in Rust's inbox (`deep_link.rs`) until the screens are installed and the page has listed its library, the first-launch notes seeded, and asked for them (`deep_link_take`, which the screens bridge calls once, as `libraryListed`); then they go to the screens, in order, and so does every later link.
  A link that launches the app on its first run would otherwise reach the screens before the welcome example exists, and its stack would end at the list.
  Under the screens a link never goes to the page: the page that asks gets none, and a reloaded page asks again once it has listed the library.
  Without the screens (the kill switch, or an install that failed) the links stay held in the inbox and are not followed: the page asks for them only under the screens.
- The iPhone answers to `devot://` in every build (`plugins.deep-link.mobile` in `tauri.ios.conf.json`, written into the app's Info.plist and `project.yml`): its debug and release builds share one bundle ID, and only one of them is installed at a time.
- The host-app XCTests (`RouteApplyTests`) deliver each route and check the stack and its animation; the `iphone-ui` XCUITest (`DeepLinkTests`) opens `devot://note/<id>` for the welcome example in the installed app.

### Restoration

When the app is about to leave the front (`UIScene.willDeactivateNotification`) and again once it is in the background (`UIApplication.didEnterBackgroundNotification`), Swift writes a record to `UserDefaults["devot.phone.screens"]`, and the next launch rebuilds the screens from it before the first frame, without animation.

```
{ "v": 1, "tab": "notes", "savedAt": 1762500000,
  "stacks": { "notes": [{ "editor": { "noteId": "…" } }], "library": [{ "trash": {} }], "settings": [{ "pane": { "_0": "sync" } }] },
  "firstVisible": { "notes": "…" },
  "newNotes": [{ "id": "…", "bookId": "…" }] }
```

- The record holds IDs and kinds only, never a title or any other note text: the selected tab, the screens above the Notes, Library and Settings roots (a note list by its view and the status it opened with, the Trash, an editor by its note, a Settings page by its pane), the first note row the top list showed, and the untouched new notes.
- A record of another version, or one that does not decode, is ignored, and every tab starts at its root.
- A launch starts at the default tab (Library) with every stack at its root after a crash or when the record is more than eight hours old.
  Swift sets `devot.phone.running` at launch and whenever the scene activates, and clears it once the app is in the background, so a launch that finds it set followed an end in the front: a crash, or a force quit from the app switcher.
  The cleared flag reaches the preferences store a moment after the app leaves, so a kill within that moment also reads as a crash.
- The rebuilt screens appear inside Rust's install, which refuses calls until it returns, so the calls they make then (`tabs.show`, `editor.show`) are held and sent in the turn after it.
- The root's first appearance can come just after the install returns, still in its turn, so the Settings start it makes (the editor settings and the glass) waits for the next turn too.
- An editor is rebuilt with an empty title, and once Rust takes requests (the turn after the install returns) Swift reads `direct.lists.titles`: a live note's title fills the bar and the cover, and an editor whose note is gone cuts its stack there without animation (`I_SCREENS_RESTORE_NOTE_GONE`).
- A New Note screen whose note is untouched is not rebuilt: its stack ends below it, and the record lists the note with the notebook it was made in.
  The next launch sends `note.discard { noteId, made: { bookId } }` for each, and the page purges the note only if it is still as made.
- A restored list scrolls its first visible note back to the top once its rows arrive; a notebook or tag list takes its name when the Library has been read, and follows a rename.
- Activity and Search start at their roots: Activity reads its figures again, and a search's query is text.
- The host-app XCTests (`RestorationCodecTests`, `RestoreFlowTests`) cover the codec and the rebuild; the `iphone-ui` XCUITest sends the app to the background, relaunches it and finds the note on top again.
- `LaunchScreen.storyboard` draws the first frame's shape: the phone background of the default theme (the `LaunchBackground` colour, which `pnpm tokens` writes from `color.phone.background`), an empty large-title bar, and the tab bar's place left clear.

## Editor screen protocol

| Message                                            | Direction    | Meaning                                                                                                                 |
| -------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `nav.openNote { noteId, title }`                   | page → Swift | a row, a search result or a link opens a note: Swift pushes its `EditorScreen` on the shown tab, the title on its cover |
| `nav.back`                                         | page → Swift | the page left the note (it was trashed from Info): Swift pops its screen                                                |
| `editor.prepare { noteId }`                        | Swift → page | a native row was pressed: the core opens and holds the note so its bytes are in memory                                  |
| `editor.show { noteId }`                           | Swift → page | the web view is in the note's screen: the page swaps the note into its one editor and shows it                          |
| `editor.focus { typed? }`                          | Swift → page | the push landed with the keyboard up: the page puts the caret in the body, types `typed` there, answers `{ focused }`   |
| `editor.hide`                                      | Swift → page | the web view is back in a list: the page hides its editor and answers once the list is painted                          |
| `editor.setMode { mode }`                          | Swift → page | the bar's toggle: `edit` or `preview`; Edit still goes through the write gate                                           |
| `editor.ready { noteId }`                          | page → Swift | the note's first frame is painted                                                                                       |
| `editor.mode { noteId, mode }`                     | page → Swift | the mode the note is shown in, so the toggle shows the other                                                            |
| `editor.title { id, title }`                       | page → Swift | the title changed, so the row, the cover and the bar's title follow at once                                             |
| `editor.scroll { titleVisible }`                   | page → Swift | whether the page's own title is still below the bar, which shows the title only once it is not                          |
| `editor.insets { bottom, duration, curve }`        | Swift → page | the keyboard moved; the page sets its bottom inset and CodeMirror's scroll margin at once and animates nothing          |
| `editor.format { id }`                             | Swift → page | a button on the native formatting bar, by the editor's format ID                                                        |
| `editor.ai { action }`                             | Swift → page | the toolbar's AI button (`suggest`) or the formatting bar's accept (`accept`)                                           |
| `editor.find { action, query? }`                   | Swift → page | the native find bar: `search` with its query, `next`, `previous`, `close`; answers `{ total, current, capped }`         |
| `editor.duplicate`                                 | Swift → page | More > Duplicate: the core copies the shown note with its tags and answers `{ id, title }`                              |
| `note.info { noteId }`                             | Swift → page | Note Info opened: answers `{ words, characters, readingMinutes, revisions, backlinks, frontMatter }`                    |
| `note.setDates { noteId, createdAt?, updatedAt? }` | Swift → page | a Note Info date picker, in milliseconds; created after modified is `E_SCREENS_DATES_ORDER`                             |
| `note.applyFrontMatter { noteId, field, value }`   | Swift → page | Note Info's Apply on a front matter row: `field` is `title`, `status` or `tags`, the tags a JSON list of names          |
| `note.addTag { noteId, name }`                     | Swift → page | the tags picker's new tag: the core makes or finds the tag, puts it on the note and answers `{ tagId }`                 |
| `editor.note { id, bookId, status, … }`            | page → Swift | the shown note's notebook, status, pin, tags and dates, again after each change, for More, the pickers and Info         |
| `editor.picker { noteId, picker }`                 | page → Swift | a chip under the title: Swift opens the `notebook`, `status` or `tags` picker                                           |
| `editor.haptic { kind }`                           | page → Swift | a haptic the editor would play, played from Swift while a note's screen is up                                           |
| `editor.gate { what }`                             | page → Swift | a write was tried while writes are locked: Swift opens the gate's sheet                                                 |
| `note.new { bookId? }`                             | page → Swift | New Note in a list's capsule: Swift's gate decides, then pushes the editor and asks for the note                        |
| `note.create { bookId? }`                          | Swift → page | the core makes an empty note and answers `{ id, rev }`, `rev` being its write's `notes.changed` revision                |
| `note.discard { noteId }`                          | Swift → page | a new note's screen left untouched: the page purges the note if it is still as made                                     |
| `licence.changed`                                  | Rust → Swift | the licence changed: Swift reads its snapshot again; only Rust may send it                                              |

- Each message joins the bridge with the change that first sends it: `editor.prepare` with the native lists, `editor.show`'s `focus` with New Note, `editor.gate` with the gate, and the editor's bars, find, pickers and Note Info (`editor.insets`, `editor.format`, `editor.ai`, `editor.find`, `editor.duplicate`, `note.info`, `note.setDates`, `note.applyFrontMatter`, `note.addTag`, `editor.note`, `editor.picker`, `editor.haptic`) with the native editor bars.
- On `editor.prepare` the page holds and opens the note (`phone/screens/prepared.ts`), and the editor takes the opened state when Swift shows it; a note no tap took is let go after 1.5 s.
- The page decides the mode, so `editor.show` carries none: Edit for an empty note while writes are allowed, Preview otherwise, and Preview for every note while writes are locked.
- A hidden editor keeps the last note open until the next `editor.show`, so going back to it costs nothing; its history and caret are kept per note as before.
- Every `editor.show` opens the note at its top, the note shown last too, and the page sends `editor.mode`, `editor.title` and `editor.scroll` again, since each show comes with a new screen.
- The page's editor host (`phone/screens/EditorHost.tsx`) draws the note without its own top bar or Back and Forward capsule: the system bar and the screens' stack replace them.
- Under the native screens the page draws none of its other bars either: the bottom bar, the formatting bar, the find bar and the info sheet are Swift's (`UI/Editor/`), and the chips send `editor.picker`.
- The More menu, the pickers and Note Info write through the gate as `WriteIntent`s; More's writes go through `ListContext.ask`, which plays their haptic.
- Move to Trash goes through `ListContext.trash`, which pops the screen only once `notes.batch` has trashed the note, so a write the gate holds, Rust refuses or the store fails leaves the screen in place.
- The More menu has no History yet: the iPhone has no history view, and History joins the menu with the native history sheet (stage 4).
- The editor's formatting bar formats only while editing is allowed; a press while locked opens the gate's sheet, as Edit does.
- A Find query sent while the note still loads waits for its editor (at most 5 s), and only the latest such query runs.
- `note.info`, `note.setDates`, `note.applyFrontMatter` and `note.addTag` are answered by the core (`phone/screens/notes.ts`); `editor.find` drives CodeMirror's search on the shown editor, and Rust refuses a query over 1000 characters (`E_SCREENS_QUERY_TOO_LONG`).
- Note Info shows the note's front matter as the Mac's card does, and the preview under the native screens leaves it out (`frontMatterInInfo`); a template's front matter stays in its preview, and its rows offer no Apply.
- A row whose title, status or tags differ from the note's shows the note's value and Apply, which goes through the gate as `WriteIntent.applyFrontMatter`; the editor screen reads Note Info again when the note's title, status or tags change while the sheet is up.
- Rust checks `note.applyFrontMatter`: a title of at most 1000 characters, a known status, and at most 200 tag names that each pass `note.addTag`'s check; the page takes only what `frontMatterChange` would have offered.
- `editor.insets` takes a bottom of at most 4096 pt, a duration of at most 2 s and a curve of at most 7, each finite and not negative (`E_SCREENS_ARGS_INVALID`).

### The page scrolls as one document

- While a note's screen is up the page is one document in the web view's own scroll view (`data-page-scrolls` on the root, `phone/screens/pageScroll.ts`): `.cm-editor` grows with its text and the editor's scroller does not scroll.
- The editor screen gives that scroll view to the system bar (`setContentScrollView(_, for: .top)`), so its scroll edge effect follows the note, and sets `keyboardDismissMode = .interactive`, so a drag down through the keyboard dismisses it.
- `KeyboardTracker` (`UI/Editor/KeyboardTracker.swift`) reads each keyboard frame change: it hides or shows the bottom toolbar and swaps the bars inside a `UIView.animate` on the keyboard's own duration and curve (`curve << 16`), then sets the scroll view's bottom inset and sends `editor.insets` once, outside the animation.
- The bottom it sends is the covered height plus the formatting bar and its gap, and the page sets `--editor-foot-inset`, which CodeMirror's scroll margin reads, at once; nothing on the page animates.
  With the keyboard down the find bar alone keeps its height and gap at the foot, and Find's opening and closing send the change.
- Only a keyboard raised for the note's own responders (the web view, the find field, New Note's hidden field) moves the bars and the insets; one raised for a sheet over the note does not, while a keyboard going down always does.
- The tracker keeps the keyboard's last frame for the whole app, so a screen shown again, or given the web view, starts from where the keyboard is now rather than where it was when the screen was covered, and sends `editor.insets` for it.
- `NOTE_PAGE_SCROLLS` in `pageScroll.ts` is the switch back to the editor's own scroller, kept until document scrolling is confirmed on every supported iOS.
- Note ids are checked as every note id is (`E_SCREENS_NOTE_ID_INVALID`), the title as a note title, and the mode against the two modes (`E_SCREENS_ARGS_INVALID`).

### The web view never changes size

The web view keeps a width and height equal to the editor screen's content area, the window's bounds, wherever it is.
In `WebStage` it is clipped, not pinned to the stage's edges, and in an editor screen it is pinned to the container's edges, which give the same size.
So a move never changes the page's viewport, and a push never starts with CodeMirror measuring again.
It moves between superviews with `addSubview` alone, never `removeFromSuperview` first, so its window is never nil.

### Row to editor

1. Touch-down highlights the cell and sends `editor.prepare`, unless the list is selecting.
2. Touch-up pushes `EditorScreen` at once, with `hidesBottomBarWhenPushed`; the push is the system's and is never retimed or waited on.
3. The list's screen leaves a still of the page, `snapshotView(afterScreenUpdates: false)`, in its own view.
   In `viewIsAppearing`, the first callback with a window, the editor's container takes the web view under a cover: `color.phone.background` with the title in the note type scale on the editor keyline, drawn natively.
   Swift sends `editor.show`.
4. The page swaps the note in under 16 ms and answers `editor.ready`.
5. The cover fades over `motion.duration.phone-adjust` once `editor.ready` arrives, never before the push's first frame.
   Without `editor.ready` after 400 ms the cover fades anyway and the page shows its own loading state.
   A note whose body cannot be opened never shows the body of the note before it: the editor is left empty and inert, the page says under the caption that the note could not be opened, and logs `W_NOTE_OPEN_FAILED` with the note's ID and the code.

A note opens in Edit when it is empty and writes are allowed, and in Preview otherwise; while writes are locked every note opens in Preview and stays there.

### Editor to list

- When a pop or an edge swipe starts, nothing moves: the live web view slides out with the leaving editor, still scrolling and still holding its caret and keyboard.
- A cancelled swipe has nothing to undo.
- When the pop completes, the revealed list's screen takes the web view with animations off, brings its still to the front and sends `editor.hide`; the still goes when the page answers, or after 400 ms.
- The popped screen's view leaves the window before the transition coordinator's completion runs, and a covered screen's view can leave it before the pushed screen appears, either of which would take the web view out of the window with it.
  So the hand-over happens as that view leaves the window (`willMove(toWindow: nil)` on the container): a covered screen leaves its still first and rests the web view in `WebStage`, a popped one gives it to the revealed screen, and the completion takes the view only if nothing has.
- A tab switch rests the web view in `WebStage` from the leaving screen; the list of the tab shown takes it and sends `editor.hide` if a note was shown, and returning to the tab shows the note again under its cover.
- The navigation bar is hidden on a list and shown on a note, each screen setting it in `viewWillAppear`; the content pop gesture is off, so only the edge swipe pops, and the back button shows only its chevron (`backButtonDisplayMode = .minimal`).

### Editor to editor

- A link pushes a new `EditorScreen`: the leaving one keeps a snapshot of the web view in its container, and the new one takes the live view under its cover and sends `editor.show`.
- Popping back keeps the live view in the leaving editor while it slides; when the pop completes, the revealed editor takes it behind its snapshot, with no cover, and sends `editor.show`.
  The snapshot fades over `motion.duration.phone-adjust` once `editor.ready` arrives, or after 400 ms, so the note it already shows never gives way to a blank cover.

### New Note

1. Until the lists are native, New Note is the button in the page's list capsule; the page sends `note.new` with the notebook New Note files into on the Mac: the view's notebook, else the default notebook, else none.
   A template list keeps the page's own flow.
2. Swift's gate (below) decides from its licence snapshot alone, in the same turn as the tap.
   When writes are locked it shows its sheet and pushes and creates nothing.
3. Otherwise Swift pushes a new `EditorScreen` at once with no title on its cover, which holds without a timeout until the note exists, and sends `note.create { bookId }` in the same turn.
   Its reply `{ id, rev }` is followed by `editor.show { noteId, focus: "body" }` once the screen holds the web view; `focus` only lets the page take the caret.
4. The keyboard follows spike S2: once the push has landed (`viewDidAppear`), a hidden 1 by 1 native field becomes first responder, then the web view does, then `editor.focus` asks the page to focus the body.
   What the user typed into the hidden field before then (at most 1000 Unicode scalars, as Rust counts them) goes with `editor.focus` as `typed`, the field is cleared, and the page types it at the caret once it has the body.
   The page answers once the note has loaded, however long its open takes (over a second on a busy simulator), and gives up only after 5 s, for an open that failed.
   When the page answers anything but `{ focused: true }` (a note that opens in Preview), Swift ends editing and the keyboard goes down.
   WebKit reveals a body focused from code by the whole editable element, taller than the room above the keyboard, and scrolls the page off its top, so once the keyboard has shown Swift puts the web view's scroll back at its top, where a new note's caret is.
5. If the core answers a licence code (`E_LICENCE_REQUIRED`, `E_LICENCE_UNREADABLE`), Swift logs `W_PHONE_WRITE_LOCKED op=note.create code=…`, pops the screen while its cover is still up, and once the pop completes reads the licence again and shows the gate's sheet with nothing held; any other code pops it with `W_PHONE_NEW_NOTE_FAILED code=…`.
   The user never sees a code.
6. Swift marks a new note touched when a `notes.changed` with a later `rev` than its create names it.
   When a new note's screen is in no stack any more (its pop completed, before `editor.hide`, or the create answered after the screen had gone), Swift sends `note.discard` for an untouched one; a back swipe turned back keeps it.
   A create that answers during a back swipe decides only once the swipe has ended, since the swipe takes the screen out of the stack until then.
   The page checks again that the note is still as made (no title, no body, no chip changed) before it purges it, so a missed `notes.changed` keeps an empty note rather than losing a word.
   A note an earlier launch made comes as `note.discard { noteId, made: { bookId } }`, with the notebook it was made in, and the page checks it against that (Restoration above).
7. The list under the pushed editor is the page's list for the note, moved to under the list's still; native lists replace it in stage 2.

### The gate

- Every write the native screens start goes through one `ProGate` (`UI/ProGate.swift`), which decides from the licence snapshot (`UI/LicenceSnapshotStore.swift`) and never waits on the bridge.
- The snapshot is only the UI's guess: Rust's write gate refuses every locked write whatever Swift decided, and a snapshot not yet read lets the write go to Rust's gate.
- The snapshot is read through `direct.licence.get` each time the app becomes active, when Rust sends `licence.changed`, when Settings shows, and before a held write runs again.
- Locked, the gate shows one surface, as `lockSurface` in `requireEditing.ts` chooses it, and holds the write's intent (what was picked, never text): the purchase sheet headed for the state in an App Store build that needs a purchase, otherwise the short Pro sheet (checking, key, attention, seat or unreadable).
  `tests/fixtures/licence-gate.json` holds both sides to the same table.
- A tap while the surface is up shows no second one.
- The intent runs only when the sheet's own action (a purchase, Restore Purchases or Try Again) unlocked writing while it was up, in the sheet's dismissal completion, through the gate again after a fresh read; it is dropped when the sheet goes without one, when the app leaves the foreground, and after 10 minutes.
- A write the page's own Pro sheet holds for the editor screen is dropped, and the sheet closed, when that screen goes (`editor.hide`, or `editor.show` as another screen takes the page).
- When a `licence.changed` read finds that writing is now allowed while the surface is up (Ask to Buy approved, an App Store retry that succeeded, a key added elsewhere), the surface closes on its own and the intent runs as after the sheet's own unlock.
- Enter License Key and Open License Settings close the sheet, drop the intent and open License over the Settings root.
- The debug launch argument `-DevotLicenceFixture A1|A2|A3|K1|K2|X1` (`Debug/LicenceFixture.swift`) fixes the snapshot for the UI tests; Rust, which does not gate a debug build, still takes every write.

### Haptics

- `Haptics` (`UI/Haptics.swift`) holds one UIKit feedback generator per kind (`selection`, `light`, `warning`, `success`, `error`) for the session, made on first use and anchored to the tab bar controller's view.
- `Screens` owns it and hands the same instance to `ListContext` and `SettingsStore`; a screen built without one makes no sound.
- `HapticEvent` names each tick and its kind; `design/motion.md` (Haptics) is the table.
- A control that may fire one calls `prepare` on touch-down; `play` prepares again before it fires, so a tick is never unprepared.
- A bar button gives no touch-down, so a list prepares when a context menu opens or the selection bar shows, and `Screens` prepares the warning while a list shows locked.
- A list write picked from a menu or the selection bar goes through `ListContext.ask`, which plays its event once the gate lets the write through; a swipe action goes to the gate directly, as the system plays its own haptic for it.
- `SettingsStore.run` plays `success` when Restore Purchases unlocked writing and `error` when a purchase or restore failed.
- Under the native screens every haptic the page plays (`phone/haptics.ts`) reaches Swift as `editor.haptic` and plays there (`Haptics.play(page:)`): `light` and `soft` as `light`, then `selection`, `success` and `warning`; a picker's choice plays `pickerChoice`.
- Rust has no haptic command, so the web fallback plays none.

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
  - on the system bars, whose glass has no public opacity, only values below 0 act: every scroll view under them, the web view's and the panes', takes the hard scroll edge effect, and from 0 up the automatic one;
  - a change applies on every move of the slider and is saved when the finger lifts, or 400 ms after the last step of an adjustment without a drag (VoiceOver, Switch Control);
  - a value that arrives within 400 ms after the lift is the drag's last one, which SwiftUI may hand over after it reports the lift, and is saved at once, so an app closed straight after a drag keeps it.
- Reduce Transparency and Increase Contrast win over Glass Transparency: the system frosts its glass, Devot's glass views follow with a solid fill, and the slider shows disabled with a footer that says why.

## Settings tree

Every pane is a SwiftUI form in a hosting controller pushed on the Settings tab's own navigation controller, so push, pop and the edge swipe are UIKit's.
The root's rows are buttons that push through `SettingsRouter`, never SwiftUI navigation links, since no SwiftUI navigation container holds them.
The page draws no Settings page: under every one the web view rests on the stage at its size, hidden from VoiceOver.
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
- The root's list ends `size.phone-tab-edge` above the tab bar, so its build footer clears the bar's scroll edge effect.
- The root and every pushed Settings page keep the reader's place when the text size changes (`PlaceKeeper`): the first row or header that starts on the screen stays where it was, until the reader scrolls again.
  The root instead keeps its foot in view once the reader has scrolled there, for its build footer; a pane pinned to its foot would push the rows at the top of the screen under the navigation bar.
  SwiftUI's list passes through a short content size at a new text size and drops its offset, so text the reader was looking at would leave the screen, which the accessibility audit's Dynamic Type check reads as text that does not scale.
  The place is marked once, as the reader's scroll ends (the run loop leaves its tracking mode), not on every frame of it.
- The panes read their snapshots (editor settings, crash reports, licence, AI, sync) through Rust-direct operations each time the root shows, and Default Notebook's choices from the page with `settings.notebooks`, so a pushed page never waits for a first read.
- A change applies to the snapshot first and then goes to Rust; Rust's newer snapshot replaces it, an older one never does, and a refused write puts the old value back, raises the `appearanceSettings.failed` alert and logs `W_PHONE_SETTINGS_SAVE_FAILED key=… code=…`.
- Sync is native, with the page's phone layout group for group: on or off with the relay and its hint, the status and its iCloud actions, the state notes, iCloud storage or the relay's usage, Move to iCloud, the recovery key until it is saved, setup or Devices (with a You badge on this device), pairing and leaving.
  `SyncLayout` derives the groups from the snapshot and the pane's own state, and `tests/fixtures/sync-pane.json` holds the groups for a set of snapshots, which the page's phone layout and `SyncLayoutTests` both match.
  Its actions are the `direct.sync.*` operations, and a failure says the page's sentence and why (`syncWhy.ts`), and logs `W_SYNC_SETTINGS_FAILED op=… code=…`.
  Confirmations are system alerts; the QR code is drawn from Rust's modules with four quiet modules round it.
  The recovery key's Copy puts it on this device's pasteboard only, gone after 90 seconds, since the page's secret clipboard command works on the Mac alone.
- Pair a Device pushes Sync with the `pairing` anchor, and the pane lands on its pairing group (or, before this device is in a vault, its setup rows) without a scroll animation once its snapshot is drawn; coming back to the tab leaves it where it was.
- A pairing on show keeps running across a tab switch and ends, cancelled in Rust, when the Sync page leaves the stack.
  It checks every 2 seconds on a relay and every 10 on iCloud, and at once on `sync.pairing`; a relay out of reach keeps it waiting, and any other failure ends it.
- `SettingsRouter.open` sets the stack to the root and the page in one `setViewControllers`, so Back lands on the root; it animates only while the app is in front.
- License runs one licence action at a time (`LicencePaneModel`): while Add or Replace, Remove or Retry waits on Rust, all three are disabled, and only that action's reply ends the wait and says how it went.
- Enter License Key in the page's Pro sheet sends the `settings.open { pane: "licence", focusKey }` notice, and Swift opens License over the root with its key field focused once the push lands.

| Message                            | From  | Meaning                                                                                                     |
| ---------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------- |
| `glass.get`                        | Swift | the page answers its stored Glass Transparency, or null, once, when this iPhone has no value of its own yet |
| `glass.set { transparency }`       | Swift | the page paints its glass at this value and keeps a copy, so it paints right at the next launch             |
| `settings.notebooks`               | Swift | the page answers the notebooks, each with `id`, `name` and `depth`, in order                                |
| `settings.open { pane, focusKey }` | page  | the page asks Swift to open License, its key field focused or not                                           |
| `sync.changed`                     | Rust  | after `devot://sync-changed`: Swift reads `direct.sync.get` again                                           |
| `sync.pairing`                     | Rust  | after `devot://sync-pairing`: the Sync pane checks a pairing on show at once                                |

- Rust sends `sync.changed` and `sync.pairing` itself, from the sync service's emitter, and only while the native screens are installed; the page sending either is refused with `E_SCREENS_NOTICE_UNKNOWN`.
- Swift keeps one `direct.sync.get` in flight, and a change heard during it reads once more after it; it reads `direct.sync.icloudStatus` again when the vault, transport, on or off, status code or iCloud join state changes.

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
  So Glass Transparency below 0 cannot reach the bars through their appearance's background colour; it reaches them as the hard scroll edge effect instead, which the system draws behind every floating bar.
  iOS 26 was not measured.
