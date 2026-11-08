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
               └─ Search    UISearchTab → UINavigationController → Search (scopes All and Titles) → EditorScreen
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
4. On `false` the app keeps the web fallback.
   Swift answers `false` when the kill switch is on or when an object is of another class, and logs why with a code.
5. At start the page calls `screens_take`, which answers `{ installed, pending }`: whether the screens attached, and the operations queued before the page listened.
6. With `installed` the page mounts the editor host alone (no tab bar, lists, sheets or glass); otherwise it mounts the web fallback.
   Both paths start the core and seed the welcome notes the same way.
7. The web fallback draws no tab bar, note list, Library, search or toast, which are all native: it opens on Activity, whose ranked notes open the page's note screen, and its Settings only from the Devot Pro prompt's License button.
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

| Area            | Operations                                                                                         | Command bodies                                      |
| --------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Editor settings | `direct.editorSettings.get`, `.set { patch }`                                                      | `editor_settings_get`, `editor_settings_set`        |
| Imported fonts  | `direct.fonts.list`                                                                                | `fonts_list`                                        |
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
| Native lists    | `direct.lists.notes { view, status, offset, limit }`, `.library`, `.trash`                         | the `Store` reads of the list commands (`lists.rs`) |

- An operation's name is its command's in camel case, so `direct.sync.icloudUploadAgain` runs the body of `sync_icloud_upload_again`.
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
- `tests/fixtures/screens/rows.json` holds one reply of each, which Rust checks its replies against by shape and Swift decodes.
- A failure is logged as `W_SCREENS_DIRECT_FAILED op=… id=… code=…`, and a request's arguments, which may hold a licence key, an AI key or a relay secret, are never logged.
- The native purchase sheet reads StoreKit's price with `direct.store.products` and buys with `direct.store.purchase`, the bodies the page's sheet calls, so StoreKit's own sheet takes the payment either way.
- Importing a font joins with the Appearance pane that first sends it.
- The sync engine's commands (`sync_connect`, `sync_pull`, `sync_push`, `sync_disconnect`, `sync_status_report`) stay the core's.

### Keeping lists fresh

- The core sends `notes.changed { rev, ids }` after each write it makes and after it takes in external changes from sync, iCloud or another process.
- It also sends `books.changed`, `tags.changed` and `savedSearches.changed`.
- Swift reads only the changed rows again from Rust and applies them to the list's diffable snapshot, so moves and inserts take the system's list animation.
- When a `rev` is not the next one, Swift reads every row the list has loaded again (at least the first page of 200) rather than guess, so the list keeps its length and scroll position.
- `notes.changed { rev, ids, all: true }` says the page cannot name the notes (a sync or a launch took in changes), and Swift reads the loaded rows again too.
- The page reports the writes a note save does not (a note's tags, a purge, and notebooks, tags and saved searches) a moment after they complete (`phone/screens/feed.ts`).

### Lists

The Notes and Library tabs' roots and every list they push are native (`DevotScreens/UI/Lists/`); Activity stays a `WebTabScreen`.

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
- A failed search is logged as `W_PHONE_SEARCH_FAILED code=…`, and the list keeps what it showed.
- Before a query the list shows this iPhone's recent searches, then the notebooks, statuses and tags, each filling the field with its clause (by name where quoting holds the name, else `bookId:` or `tagId:`) and searching.
- Recent searches are the six newest queries whose result was opened, kept in `UserDefaults` and never synced or logged.
- A result opens its `EditorScreen` on the Search tab, so Back lands in Search with the query and results as they were.
- A saved search in the Library opens the Search tab at its root and runs its query without raising the keyboard.

### Tabs

The Notes and Library tabs are navigation stacks with the system bar and large titles over native lists (Lists above).
The Activity tab is a navigation stack with a hidden bar whose root, `WebTabScreen`, holds the web view while its tab is shown, and the page draws that tab's stack.
A list that appears asks the page to let the shown note go, as a web tab does when it takes the web view.
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
- The web view rests in `WebStage` when a tab's screen disappears, and the next tab's screen takes it, so a tab switch never takes it out of the window; when a native tab shows first, the web view goes to the stage as the screens appear.
  The stage hides it from VoiceOver and the accessibility audit, which would otherwise reach the page drawn behind the native Settings.
- `WebTabScreen`'s view reports the window's safe area insets, and the web view derives its own from them: the page lays itself out by `env(safe-area-inset-*)` exactly as without the system bar, and its own room for a floating bar at the bottom clears the system's.
- The view overrides `safeAreaInsets` because the tab bar's inset can reach it through its superview, which a negative `additionalSafeAreaInsets` does not take back (on iOS 26.5 each screen kept the bar's 49 points).
- The bar's tint is `color.accent.text` and it is never minimised on scroll.
  Glass Transparency does not reach it: the floating tab bar ignores a bar tint (spike: bar tint).
- The host-app XCTests check the bar's items, the web view's moves and the key window; the `iphone-ui` CI job's XCUITest (`src-tauri/apple/DevotUITests/Tests/TabsTests.swift`) launches the real app, switches all four tabs by their names and runs the accessibility audit on the bar (docs/specs/quality.md, CI).

## Editor screen protocol

| Message                                     | Direction    | Meaning                                                                                                                 |
| ------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `nav.openNote { noteId, title }`            | page → Swift | a row, a search result or a link opens a note: Swift pushes its `EditorScreen` on the shown tab, the title on its cover |
| `nav.back`                                  | page → Swift | the page left the note (it was trashed from Info): Swift pops its screen                                                |
| `editor.prepare { noteId }`                 | Swift → page | a native row was pressed: the core opens and holds the note so its bytes are in memory                                  |
| `editor.show { noteId }`                    | Swift → page | the web view is in the note's screen: the page swaps the note into its one editor and shows it                          |
| `editor.focus`                              | Swift → page | a new note's push has landed with the keyboard up: the page puts the caret in the body and answers `{ focused }`        |
| `editor.hide`                               | Swift → page | the web view is back in a list: the page hides its editor and answers once the list is painted                          |
| `editor.setMode { mode }`                   | Swift → page | the bar's toggle: `edit` or `preview`; Edit still goes through the write gate                                           |
| `editor.info`                               | Swift → page | the bar's Info button: the page opens Note Info                                                                         |
| `editor.ready { noteId }`                   | page → Swift | the note's first frame is painted                                                                                       |
| `editor.mode { noteId, mode }`              | page → Swift | the mode the note is shown in, so the toggle shows the other                                                            |
| `editor.title { id, title }`                | page → Swift | the title changed, so the row, the cover and the bar's title follow at once                                             |
| `editor.scroll { titleVisible }`            | page → Swift | whether the page's own title is still below the bar, which shows the title only once it is not                          |
| `editor.insets { bottom, duration, curve }` | Swift → page | the keyboard moved; the page sets its bottom inset and CodeMirror's scroll margin at once and animates nothing          |
| `editor.format { id }`                      | Swift → page | a button on the native formatting bar, by the editor's format ID                                                        |
| `editor.gate { what }`                      | page → Swift | a write was tried while writes are locked: Swift opens the gate's sheet                                                 |
| `note.new { bookId? }`                      | page → Swift | New Note in a list's capsule: Swift's gate decides, then pushes the editor and asks for the note                        |
| `note.create { bookId? }`                   | Swift → page | the core makes an empty note and answers `{ id, rev }`, `rev` being its write's `notes.changed` revision                |
| `note.discard { noteId }`                   | Swift → page | a new note's screen left untouched: the page purges the note if it is still as made                                     |
| `licence.changed`                           | Rust → Swift | the licence changed: Swift reads its snapshot again; only Rust may send it                                              |

- Each message joins the bridge with the change that first sends it: `editor.prepare` with the native lists, `editor.show`'s `focus` with New Note, and `editor.insets`, `editor.format` and `editor.gate` with the native toolbar and gate.
- On `editor.prepare` the page holds and opens the note (`phone/screens/prepared.ts`), and the editor takes the opened state when Swift shows it; a note no tap took is let go after 1.5 s.
- The page decides the mode, so `editor.show` carries none: Edit for an empty note while writes are allowed, Preview otherwise, and Preview for every note while writes are locked.
- A hidden editor keeps the last note open until the next `editor.show`, so going back to it costs nothing; its history and caret are kept per note as before.
- Every `editor.show` opens the note at its top, the note shown last too, and the page sends `editor.mode`, `editor.title` and `editor.scroll` again, since each show comes with a new screen.
- The page's editor host (`phone/screens/EditorHost.tsx`) draws the note without its own top bar or Back and Forward capsule: the system bar and the screens' stack replace them.
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
   The page answers once the note has loaded, however long its open takes (over a second on a busy simulator), and gives up only after 5 s, for an open that failed.
   When the page answers anything but `{ focused: true }` (a note that opens in Preview), Swift ends editing and the keyboard goes down.
   WebKit reveals a body focused from code by the whole editable element, taller than the room above the keyboard, and scrolls the page off its top, so once the keyboard has shown Swift puts the web view's scroll back at its top, where a new note's caret is.
5. If the core answers a licence code (`E_LICENCE_REQUIRED`, `E_LICENCE_UNREADABLE`), Swift logs `W_PHONE_WRITE_LOCKED op=note.create code=…`, pops the screen while its cover is still up, and once the pop completes reads the licence again and shows the gate's sheet with nothing held; any other code pops it with `W_PHONE_NEW_NOTE_FAILED code=…`.
   The user never sees a code.
6. Swift marks a new note touched when a `notes.changed` with a later `rev` than its create names it.
   When a new note's screen is in no stack any more (its pop completed, before `editor.hide`, or the create answered after the screen had gone), Swift sends `note.discard` for an untouched one; a back swipe turned back keeps it.
   The page checks again that the note is still as made (no title, no body, no chip changed) before it purges it, so a missed `notes.changed` keeps an empty note rather than losing a word.
7. The list under the pushed editor is the page's list for the note, moved to under the list's still; native lists replace it in stage 2.

### The gate

- Every write the native screens start goes through one `ProGate` (`UI/ProGate.swift`), which decides from the licence snapshot (`UI/LicenceSnapshotStore.swift`) and never waits on the bridge.
- The snapshot is only the UI's guess: Rust's write gate refuses every locked write whatever Swift decided, and a snapshot not yet read lets the write go to Rust's gate.
- The snapshot is read through `direct.licence.get` each time the app becomes active, when Rust sends `licence.changed`, when Settings shows, and before a held write runs again.
- Locked, the gate shows one surface, as `lockSurface` in `requireEditing.ts` chooses it, and holds the write's intent (what was picked, never text): the purchase sheet headed for the state in an App Store build that needs a purchase, otherwise the short Pro sheet (checking, key, attention, seat or unreadable).
  `tests/fixtures/licence-gate.json` holds both sides to the same table.
- A tap while the surface is up shows no second one.
- The intent runs only when the sheet's own action (a purchase, Restore Purchases or Try Again) unlocked writing while it was up, in the sheet's dismissal completion, through the gate again after a fresh read; it is dropped when the sheet goes without one, when the app leaves the foreground, and after 10 minutes.
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
- The editor's and the web panes' haptics stay the page's `haptic` command (`native/ios/uikit.rs`) until the editor's bars are native.

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
- The root's list ends `size.phone-tab-edge` above the tab bar, so its build footer clears the bar's scroll edge effect; once the reader has scrolled to the foot, the root keeps the foot in view while the list's content grows (`FootKeeper`), since the list would keep its offset and a larger text size would push the footer off the screen, which the accessibility audit's Dynamic Type check reads as text that does not scale.
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
