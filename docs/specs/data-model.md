# Data model

Part of the [architecture overview](../architecture.md).

- IDs are UUIDv7.
  Deletes are soft (tombstones), so they sync.
- **Note body:** a Yjs document per note, holding the Markdown text in a `Y.Text`.
  The Yjs document is the source of truth for the body.
- **Authorship** (ADR 0007, `src/core/authorship.ts`): beside `body`, the note's Yjs document holds two root maps.
  `writers` maps a session (one MCP connection, one start of the HTTP API, one Edit with AI sheet) to its kind (`mcp`, `http`, `aiEdit`, set by Devot), its name (the MCP client's `clientInfo.name`, one line of at most 100 code points without control or bidirectional characters; only shown, never trusted) and its process's HLC node ID.
  `writes` maps each agent write to its session, its time, the Yjs item IDs it inserted into and deleted from `body` (varuint ranges), the text it deleted (at most 1 MiB per note, the oldest writes' dropped first), the metadata it changed and whether it made the note.
  A write and its record are one Yjs transaction.
  Text is attributed by item ID, so the records sync, merge and survive restarts and compaction with the body; a record that does not parse is skipped and kept.
  Undo All for one writer (`reverseWrites`, `NoteService.undoAgentWrites`) puts back what it deleted where the deleted items sit and deletes what it inserted, keeping the owner's and other writers' text; Clear Authorship (`clearAuthorship`) empties both maps.
- **Agent writes index** (schema v20 `agent_writes`): one row per write, derived from the maps as `body_md` is from the body and written with the note in the same transaction; never synced, rebuilt by the note's next write when missing.
  `seen` is this device's: a row starts unseen, an `aiEdit` one seen, and so does a duplicate's (the owner made the copy).
  The main window marks the writes its review notice showed seen when the owner leaves the note, dismisses the notice or closes the window (`NoteService.markWritesSeen`, which saves the note first).
  Purging a note deletes its rows; the Trash keeps them.
  `agent_writes_list` and `agent_writes_seen` read it and mark rows seen; Rust checks every row `note_put` brings.
- **Body versions:** a write replaces a note's stored Yjs state whole, so every write compares before it overwrites.
  A note's body has a version (schema v16 `notes.body_version`; bodies from before are at 0), which every write moves on by one, and a record carries the version of the body its writer last saw (`bodyVersion`: the stored one when it is read).
  Storage writes a note only while its body is still at that version (`putNote`, in the Rust store, the better-sqlite3 adapter and the UI tests' memory storage alike; a new note is stored at the next version too); a write based on another version would go over a body another writer wrote since (any other connection, the core of another window showing the note, later sync), so it is refused with `E_NOTE_BODY_STALE` and changes nothing, and a purged note is left alone whatever the version.
  The note service then takes the stored copy in, as when it hears of an outside write (`takeIn`: a Yjs merge, so neither side's text is lost, and the newer HLC of each metadata field), and writes again (`put` in `src/core/notes/saving.ts`), five times a write at most (`WRITE_TRIES`): a save the other keeps getting ahead of fails like any other, keeping its changes, and is tried again later (see Saving and quitting).
  A change written without loading the note and a restore from the Trash read the note again and write again the same way; moving a note to the Trash writes the body as its document holds it, with what it took in since its last write.
  A write may be based on a whole number below 2^53 − 1 (`MAX_BODY_VERSION`), so the version it moves on to is still exact in JavaScript; `note_put` refuses any other with `E_NOTE_VERSION_INVALID`, as every storage adapter does (`checkNote`).
- **Hand-set dates:** Note Info's Created and Updated rows set a note's created and updated dates (`noteInfo/NoteInfoCard.tsx`).
  A click on a row opens Devot's own date picker under it (`DatePicker.tsx`, its logic in `noteInfo/calendar.ts`): a month with the days of the weeks around it, the week starting on the locale's first day, and the hour and minute (with AM and PM where the locale writes them).
  The picker keeps the date's seconds and milliseconds and turns off the days the other date rules out: Created no later than Updated, Updated no earlier than Created.
  A date left unchanged is written back exactly as stored, even in the hour that comes twice when the clocks go back.
  Set is turned off while the time breaks that rule, is incomplete or is skipped when the clocks go forward, and says why; Return sets, Escape cancels, and a save that fails says so and keeps the picker open.
  Both dates share one HLC (schema v17 `notes.dates_hlc`, `datesHlc` on a record, '' when never set): a write with a newer one sets both as written, any other keeps `created_at` and moves `updated_at` only forward, in every storage adapter alike.
  `NoteService.setDates` refuses a time that is not a whole, non-negative millisecond count, or a note updated before it was created (`E_NOTE_TIME_INVALID`, as `note_put` does).
  The next edit moves the update date on as usual.
- **Metadata** (title, notebook, tags, status, pinned): SQL rows.
  Each field is last-writer-wins, ordered by a hybrid logical clock (HLC) timestamp.
  Storage enforces it: writing a record merges it field by field and keeps the value with the newer HLC, so writing a stale copy never undoes a newer change (Rust store and the TypeScript adapter use the same SQL).
  The core's clock takes in (`receiveStored` in `src/core/hlc.ts`, through `Clock.receive`) the stamps of every record it reads before writing over it: a note when it is loaded, read from the Trash or merged with what another process wrote (`mergeStored`), notebooks and tags when listed, and a note's tag membership row before a tag goes on or off (`getNoteTag`, command `note_tag_get`).
  So a write always wins over the value it is based on, even when that value was written while the system clock ran ahead and the clock has been set back since; a restore from the Trash, a rename or a move would otherwise lose to it, silently, until the clock caught up.
- **Tags** may have a colour (schema v11 `tags.color`, a field merged by HLC like the others).
  It is an ID from a fixed palette (`TAG_COLORS`: red, orange, yellow, green, blue, purple, pink, gray), which each theme colours through the tokens `color.tag.<id>`, light and dark, or a custom colour as lowercase `#rrggbb`, which needs no migration (the column is free text).
  Rust and the core accept only those two forms (`valid_tag_color`, `isTagColorValue`; a notebook icon keeps the palette alone); storage reads any other value (a later Devot's, through sync) as no colour, keeping its HLC, and that is how a Devot from before custom colours reads one.
  Such a device shows the tag with no colour, and if it edits that tag it resets the colour on every device.
  The theme adapts a custom colour's label and icon (`src/renderer/src/theme/tagInk.ts`), never its dot.
- **Notebook icons** (schema v18 `books.icon`, `books.icon_color`, one HLC `icon_hlc` for both, since they are picked and reverted together): Change Icon… in the notebook menu opens a picker (search over names and keywords, a tab per category, a palette colour row, with a choice of icon set, opening on the current icon's set, else the Icon style setting) over two fixed catalogs, SF Symbol names (`design/icons/notebook-symbols.json`) and Lucide names (`design/icons/notebook-lucide.json`), both read by `src/core/notebookIcons.ts` and embedded in Rust.
  The icon is a catalog name, stored as `lucide:<name>` for Lucide (no migration: `books.icon` stays text, and a version without that catalog reads it as unset like any later name), the colour a `TAG_COLORS` ID; the stored set is drawn whatever the Icon style setting, and only an unset icon follows the setting.
  The Lucide glyphs are one chunk loaded on demand (`icons/lucideNotebook.ts`); Revert to Default clears both.
  An icon is drawn in the theme's `color.tag-icon.*` token for its colour: the tag colour, darkened in the light themes only as far as 3:1 on the sidebar, lists, editor and popovers needs (yellow, orange, green and gray on white; `contrast.test.ts`).
  Rust accepts only catalog names and palette IDs (`E_BOOK_ICON_INVALID`), and every storage reads a name or ID it does not know (a later catalog, through sync) as unset, keeping its HLC.
  A Devot from before the Lucide catalog therefore shows no icon for a `lucide:` name, and if it edits that notebook it resets the icon on every device.
  The icon shows in the sidebar, the note's notebook picker, the Move dialogs and the palette's notebook rows; the picker renders only the symbols scrolled into view (rendered symbols are cached per name, size and appearance).
- **Names** (notebooks, tags): trimmed by one whitespace rule on both sides, Unicode's White_Space as Rust's `str::trim` reads it (`trimWhitespace` in `src/core/text.ts`; JavaScript's own `trim()` differs on U+0085 and U+FEFF), one line, at most 200 (notebook) or 100 (tag) code points.
  The name fields stop at those limits, counted in code points (`src/renderer/src/nameLimit.ts`; HTML's `maxLength` counts UTF-16 units).
  Tag names are unique in any case: a rename onto another live tag's name is refused (`E_TAG_NAME_TAKEN`).
  A name typed is looked up by name (made when missing; tags are made and renamed one at a time, so two at once never make two of one name); a tag picked from a list (a drop on its row, the palette's Add Tag, the tag picker) goes on by ID, so two tags of one name that sync brings stay apart.
  A refused notebook or tag change is logged by code and shown in a notice that says the rule broken (or only that the change failed).
- **Notebooks** nest through `parent_id` (no foreign key, so sync can deliver children first).
  Deleting a notebook deletes its sub-notebooks; their notes are kept and count as in no notebook (they keep `book_id`, so restoring the notebook brings them back).
  A missing parent makes a notebook top level, and a parent cycle from concurrent moves is broken at its smallest ID, the same way on every device.
  Selecting a notebook lists its notes and those of its sub-notebooks.
  Deleting a notebook (Delete Notebook, Backspace or Delete on its row) asks first, like deleting a tag: the question names the sub-notebooks that go with it and the notes that stay, Return confirms, Escape or Cancel keeps it and the keyboard returns to the row.
  Phase 1 has no restore for a deleted notebook (a backup restore brings it back).
- **Notebook order** is the user's own (schema v10).
  Each notebook has a sort key, a fractional index (`src/core/order.ts`: base-62 strings compared as plain strings, with a key between any two), merged by its own HLC.
  Siblings show in key order, equal keys (two devices moving notebooks into the same gap) by ID, so every device shows the same order.
  A move writes one row: the moved notebook's key and, when it changes, its parent; only when its neighbours share a key (or a key from sync is malformed) do the siblings get fresh keys.
  A reorder keeps a stored parent that is missing (the notebook shows at the top level until it arrives).
  New notebooks go after their siblings.
  The v10 migration adds empty keys.
  Notebooks without a key show as before, by name in the locale's collation (then ID), ahead of keyed siblings, and the core keys them in that order when it starts (`BookService.settleOrder`, one write per such notebook), so names with accents or in other scripts keep their place.
  These keys carry no clock: any later move wins, and when two such keys meet the greater wins, so devices that keyed apart still converge.
- **Markdown snapshot:** derived from the Yjs document on save (debounced).
  FTS5 search, export and MCP read the snapshot.
- **Task progress:** a note's task items, how many are done and how many there are (`taskProgress` in `src/core/extract.ts`), are derived from the body when they are shown and never stored, synced, encrypted or written to the Markdown mirror.
  The note list's rows (`NoteService.rowDetails`), board cards and gallery captions (`NoteService.taskCounts`) ask the core for the notes they render, edits not saved yet included, and keep the answer until the note's update time moves.
  Every write of a body (the editor, import, sync, the MCP server and HTTP API, history, templates) is counted the same way, since the count reads the body itself.
  There is no stored column for it: a note summary comes from an index that never reads the note's row, and a window re-dates the notes it writes without listing them again, so a stored count would lag each edit until the next reload.
- **Rule:** nothing writes the snapshot directly.
  Import and MCP note creation both compute a text diff and apply it to the Yjs document as Yjs operations.
- **Lineage** (ADR 0002, risk 1): every write to a body changes the note's existing Yjs document, so two devices' states of one note always merge without duplicating text.
  Typing reaches the core as the editor replica's Yjs updates (`applyUpdate`); every write that has only the new text (`setBody`: import, the AI service's `create_note` and `update_note`, the local HTTP API's, templates, Restore) applies the edits `textEdits` (`src/core/diff.ts`) finds: a line diff, each run of changed lines trimmed to the characters that differ, so lines the write leaves alone are never rewritten and an edit another device made to them stays in its place (past the line diff's work bound, 2,000 changed lines and fewer in a long note, the changed middle is one replacement).
  Appending a template, putting in a pasted image's link (`insertAt`) and the attachment IDs of a duplicate are Yjs operations on the note's document too.
  A new note (create, Duplicate, New Note from Selection, an import) starts its own lineage, which every later write continues; a duplicate starts from a copy of its source's state.
  Writes that do not touch the body (a batch, the Trash and restoring from it) store the body's Yjs state as it was.
  The Markdown mirror never reads a file back.
  First-launch notes, the one body every device writes under the same ID, are seeded as the same Yjs state everywhere (see First-launch notes).
  `tests/core/lineage.test.ts` checks each path: two devices write to one note, and merging both states shows each change once, where it was made.
- A note's stored Yjs state is one whole document, replaced on each write (see the Body versions item above), so there is no update log to compact.
  _Phase 2:_ sync keeps this shape: the relay stores each record's latest encrypted state and clients merge on a rejected push, so there is still no update log (ADR 0002).
- Core tables: `notes`, `books` (nestable notebooks; one reserved for templates, see Note templates), `tags`, `note_tags`, `files` (attachments), `links` (link index), `revisions` (revision history, local), `agent_writes` (derived, local; see Authorship), `saved_searches` (schema v25; see Search > Saved searches), `sync_records` and `sync_state` (what sync knows of each record, schema v19; see Sync and encryption).
  _Phase 2:_ `chunks` (a vector column for semantic search) is not created yet.
  AI edit proposals have no table: a proposal lives in the Edit with AI sheet until it is accepted or discarded, and an accepted one follows the same rule as import and MCP, a text diff applied as Yjs operations (see AI > Edit with AI).
- FTS5 uses the `trigram` tokenizer, so Chinese substring search works.
  Triggers keep the index in step with `notes`; a write puts a note's text in again only when its title or its Markdown changed (schema v15), so a notebook, status, pin or Trash change costs no indexing.
  A save no longer indexes anything itself (schema v29): the triggers only mark the note stale in `search_stale`, keeping the text the index holds for it, since FTS5 takes a row of external content out of the index only given the text it was indexed with.
  The store re-indexes stale notes later (`CATCH_UP_SQL`, the same statements in both stores): the database thread does it once writes have been quiet for 5 s (60 s at the latest while writes never pause), 50 ms of notes at a time between other jobs, and a search that reads the index (a word of three characters or more) and a purge first catch up every stale note, so they read what the notes hold now.
  `CATCH_UP_SQL` leaves a note that is not stale alone, since inserting a row the index already holds counts it twice and fails FTS5's integrity check: a purge of an indexed note with no title and no text changes nothing, so it leaves no stale row.
  A burst of saves of one note costs one re-index; saving a 1 MB note went from about 72 ms to 12 ms on better-sqlite3 (`tests/core/search-catch-up.bench.test.ts`).
  A write from another process (`data_version` moving) starts the same 5 s wait, since the outside-change watch reads it through the thread every second.
  That first catch-up has no budget: after a burst of saves (a sync, say) it re-indexes every stale note in one write transaction, which another writer can wait on up to the busy timeout.
  The 60 s limit can fall while someone is still typing, so a long note's re-index then lands between two saves about once a minute.
  On a 5 MB note (synthetic text) a save writes about 10 MB of write-ahead log and a catch-up 6 to 26 MB, as FTS5 merges segments; a save wrote 11 to 38 MB before, so one settled edit writes about as much as before and a burst of saves far less.
  The stale set is in the database, so a quit leaves it for the next launch, whose database thread catches up 5 s after its last write.
  A build from before schema v29 still running against an upgraded file (an old window or helper left open) keeps saving under the new triggers but never catches up, so its searches miss edits until a newer process catches up.
  Its purge also runs its own attachment hand-over against that index without catching it up, so an attachment can be deleted instead of handed over when another note was edited to show it since the last catch-up.
  That purge only marks the purged note's text stale, and the newer process's catch-up later removes it with FTS5 `secure-delete` off, so its trigrams stay in the index pages.
  Both need a process that was already open during the upgrade, since an older build refuses to open a file with a newer schema.
  A contentless index (`contentless_delete=1`) would need no copy of the old text, but its deletes only leave tombstones, so a purged note's trigrams would stay in the file's pages until the whole index is rewritten.
  Rebuild Search Index stays one `'rebuild'` statement and empties `search_stale` in the same transaction.
- Markdown export (see Export and print) writes notes and notebooks as Markdown files that import back as they were.

## Schema and migrations

- Migrations are numbered SQL files in `src-tauri/migrations/`, shared by the Rust app and the TypeScript better-sqlite3 adapter, so both always see the same schema.
  A released migration is never edited.
- `PRAGMA user_version` records the applied version.
  A database from a newer Devot is refused rather than opened.
- A fixture database is kept for every released schema version and must upgrade cleanly (`src-tauri/tests/fixtures/schema-v<N>.sqlite`: 18 for v1.0.4, 19 for the v1.0.5 betas, 23 for v1.1.0, each with live, trashed and purged notes, notebooks, a tag, an attachment, a link and versions, made as `schema-fixtures.sql` there says, and v23 with sync state, records of every kind and an agent write as `schema-v23.sql` says; v1 from before).
- Pragmas: WAL, `synchronous = FULL`, `foreign_keys = ON`, a 5 s busy timeout (so another process and the app can share the file), and `secure_delete = ON` (overflow pages too, unlike `FAST`), so a note deleted for good leaves no readable text in free pages, which every later backup would copy.
  A purge also takes the note's text out of the search index's pages (FTS5 `secure-delete`, on only for the purge: on for every change it would make indexing a long note's edit about 30 times slower).
  That is the text the index holds, which for a stale note is the copy in `search_stale`, also overwritten as its row goes.
  Other changes only mark a note's old text deleted in the index, so earlier text of a purged note stays there until FTS5 merges its segment.
  Pages freed before a version that set these keep their text until reused; frames in the write-ahead log keep it until the log restarts after a checkpoint (backups read the database, not the log).
- Every write transaction begins `IMMEDIATE` (the Rust store sets it on its connection; the better-sqlite3 adapter uses `.immediate()`): it takes the write lock first, so it waits out the other writer for the busy timeout.
  A deferred one that read first (an attachment's note, the search index on its first use after launch) would fail at once with `E_STORAGE_BUSY` instead (`tests/core/busy-writes.test.ts` and the Rust store's tests hold the lock from another connection).

## App data folder

- The release app (built by the release workflow, which compiles with `DEVOT_RELEASE_BUILD=1`) keeps everything in `<app data>`, `~/Library/Application Support/io.github.jma49.devot`: the database (`devot.sqlite`), `backups/`, `logs/`, `crash-reports/`, `usage.sqlite`, `mcp-access.json`, `editor-settings.json`, `ai-settings.json`, `fonts/` (imported editor fonts), `keyboard-shortcuts.json`, `note-windows.json` (where each note window was, see Note windows), `plugins/` and `plugins.json` (installed plugins and what each was granted, see Extensions) and `pdf/` (a PDF while it is printed, see Export and print).
- A debug build (`pnpm dev`, `pnpm build:debug`, every test build) uses `io.github.jma49.devot.dev` instead: `src-tauri/src/data_folder.rs` adds `.dev` to the identifier Tauri names the app's folders after, so development never opens, migrates or deletes the notes of an installed Devot, whichever branch it was built from.
  The bundle identifier stays the same, and WebKit keeps website data per bundle identifier, so a debug build also gives every window a WebKit data store of its own (`web_data_store` in `data_folder.rs`, a fixed identifier): its local storage (focus mode, the sort order, recent templates, pane widths) and caches stay apart from an installed release app's.
  The release app keeps WebKit's default store.
- A release build made anywhere else (`pnpm build` on a Mac) uses `io.github.jma49.devot.local` the same way, with a WebKit data store of its own.
  The keychain items are named after the same identifier, so such a build never joins the access list of the installed app's items; one that did would make macOS ask the installed app for the login password at its next read, and a refused prompt reads as `E_LICENCE_KEYCHAIN_DENIED`.
  The HLC node ID is not kept there: each start of the window makes a new random one (`newNodeId` in `src/core/hlc.ts`, 64 bits), so two processes never stamp a write alike.
- **One Devot per data folder:** at launch the app locks its data folder (an advisory `flock` on the folder itself, `take_folder` in `src-tauri/src/startup.rs`, so no file is written for it) and holds it for the life of the process; the system lets go of it when the process ends, however it ends.
  A second Devot on the same folder (another copy of the app, or the binary started again while the single-instance socket cannot be used, see URL scheme; otherwise a second launch hands over its arguments and quits first) opens nothing: it logs `E_STARTUP_FAILED E_DATA_FOLDER_IN_USE`, says in the launch alert that Devot is already open, and exits.
  A folder that cannot be locked at all (a file system without locks) is logged (`W_DATA_FOLDER_LOCK_FAILED`) and used without the lock.
  The MCP bridge takes no lock: it opens no database.
- **A launch that cannot open the notes** (`src-tauri/src/startup.rs`): every step of setup fails with a code rather than handing Tauri an error, which it would turn into a panic (no window, no message, the code lost).
  The failure is logged as `E_STARTUP_FAILED <code>`; a native alert (`NSAlert`, its text from `strings.rs` by the code's kind: already open, a database from a newer Devot, a damaged database, a full disk, a folder that cannot be written, a busy database, anything else) says what happened and where the data folder is, never the code; the app exits with status 1 once it is dismissed.
- Scripts never name the release folder (`tests/policy/data-folder.test.ts`); `scripts/app-data.sh` knows the dev folder.
  `scripts/smoke/quit-saves.sh` runs the debug bundle on it: it refuses while another process has the dev database open, copies a dev database that is there with SQLite's online backup (into `smoke-backups/`, where the copy stays) and puts it back afterwards, and stops if the app it started opened any other database.
  It starts the app with HOME in a temporary folder in which only the dev folder is real, a link to it, so a bundle that keeps its data elsewhere (one built before debug builds had a folder of their own) opens a new database in that folder and is stopped having touched nothing real.
  `scripts/perf/launch-cost.sh` runs the app with HOME in a temporary folder, so even a release build starts on a data folder of its own.
  Both end only the processes they started, by process ID.
- The UI tests keep notes in an in-memory storage (`src/renderer/src/storage/memory.ts`), chosen at build time: Vite's `define` sets `DEVOT_UI_TEST`, true only in the UI tests' config (`vite.ui-test.config.ts`), so no environment variable or `.env` file can turn it on.
  The app's builds leave that storage out, and the release UI build fails if the bundle holds it (`scripts/sentry/ui.ts`; `tests/policy/source-maps.bench.test.ts`).
  `pnpm vite --config vite.ui-test.config.ts` serves that build in a browser.

## Saving and quitting

- The core saves a note 300 ms after the last edit, or longer for a large one, since each save encodes its whole Yjs state: the wait grows with the state's size as last saved, from 300 ms at 64 KB to 2 s at 1 MB and beyond (`saveDelay`).
  Quitting, opening another note, searching and the other flushes still save it at once.
  Writes of one note go one at a time, in order, each with the note as it is when the write starts, so an older snapshot never lands after a newer one; a flush waits for a write under way.
- **Notes in memory:** the core keeps a note's Yjs document in memory while it is used, and only the most recently used notes once nothing uses them (`NOTES_IN_MEMORY`, 8), so browsing a library does not keep every note it opened.
  A note leaves memory only when nothing of it can be lost: no call is using it, no editor shows it (the editor holds its note while it is open, `hold` and `unhold`, so its replica and the core's document never part), no write is asked for or under way, no change is waiting for its save or failed to save, and its title is not being typed (quick title edits stay one event).
  Typing not kept as a version yet becomes one first, as when quitting.
  A note that left is read from storage again when it is next used, with what was saved and what another process wrote meanwhile; calls that ask for a note while it is being read share that read, so a note is never in memory twice.
- **A save that fails loses nothing:** the note keeps its changes in memory and stays pending.
  The core tries it again 1 s later, waiting twice as long after each failure in a row (at most 30 s), and whenever something else saves it (opening another note, searching, quitting).
  It reports the note to the window (`onSaveProblems`; the worker sends the list on the channel its replies take, so the window hears of a failure before the reply of the call it happened in), which logs `W_NOTE_SAVE_FAILED <note ID> <code>` once per note and code and shows a notice while any note is unsaved: how many notes, Try Again and Dismiss (a new failure brings it back).
  Everything else goes on: a flush saves the other notes and then rejects with `E_NOTE_SAVE_FAILED` and the IDs it could not save, which the window's own saves ignore.
  A metadata change written at once (`writeMeta`, a batch change) that fails takes back only its own field.
  For a note not in memory it does not load the note: the stored record is written back with the field changed and its body as stored (no Yjs document is built), after the body is kept as a version when the history does not end with it, as a write of the note in memory would; a load of the note waits for such a write.
  A batch checks its notebook once for all its notes (a notebook that is not live refuses the batch), so a move costs five storage calls a note (300 notes of 3.5 KB: 1,804 calls and 221 ms before, 1,505 and 116 ms after, better-sqlite3); `release` (import, the AI service) lets the note go and throws, since its caller undoes it.
- **The core must start, visibly:** the core worker starts when the window opens (`connectCore` in `src/renderer/src/coreConnect.ts`).
  A worker that does not load or raises an error before it is ready (`E_CORE_WORKER_FAILED`), a core that takes longer than 30 s to start (`E_CORE_START_TIMEOUT`) and a first load of the lists that fails (the load's own code, such as `E_STORAGE_BUSY`) are logged as `W_CORE_START_FAILED` with the code, and the window shows an error state in place of the library (`StartFailure.tsx`): what failed, a pointer to Help > Export Diagnostics… (whose logs hold the code) and Try Again, which stops the worker and starts the core again.
  An empty library is never shown for a core that is not running.
  The main window lists its notes from the page's own storage and splits off the templates there (`listLibrary` in `src/renderer/src/core-client.ts`), so the summaries Rust sends are not copied to the worker and back.
  An error the worker raises after it started (an uncaught error or an unreadable message) is logged with its code and shown as a notice; the worker is kept, since it may hold unsaved changes.
  A worker that stops without any event cannot be told from a slow one and is not detected.
- **Note limits:** a title is one line (no line feed or carriage return) of at most 1,000 code points, a body at most 32 MiB of UTF-8, a Yjs state at most 64 MiB, and a body links to at most 10,000 notes.
  Rust's `note_put` refuses anything else, so the core keeps titles within the limit: line breaks become spaces and a longer title is cut (`clipTitle`, applied by the title field, `setTitle` and every way a note is made; import and templates also tidy spaces first).
  A title stored past the limit (by an older build) is cut when the note is loaded or restored from the Trash, so its writes are taken; the stored title stays until a rename, since a write with the same HLC never replaces it.
  Every storage adapter refuses the rest with `note_put`'s codes (`checkNote` in `src/core/noteLimits.ts`), so the core and its tests see what the app would; a policy test keeps the numbers equal to Rust's.
- Quitting does not lose that window: Rust holds the exit, emits a flush event, and exits when the UI reports that the core has saved (or after 2 s, so a stuck UI never blocks quitting).
  Every window with a core of its own saves, each main window and each note window, and the exit waits for all of them (`ExitGate` in `src-tauri/src/exit.rs` keeps the windows it waits for; one that closes meanwhile counts as saved).
  When the quit's save fails (any failure counts, whether or not the window has heard which notes failed), the first such quit is called off instead (`app_exit_cancel`): the window stays open with the changes and the notice says that quitting again quits without them.
- A quit stops a running Rebuild Search Index, whose one statement would otherwise keep the saves queued behind it on the database thread waiting past the 2 s: a progress handler, installed for the rebuild alone, asks `exit::quitting` every 100 SQLite steps, and a stop rolls the rebuild's transaction back, leaving the index as it was (`E_SEARCH_REBUILD_STOPPED`).
  Not `sqlite3_interrupt`, which is lost when it lands between two statements and could stop the save that runs next.
- On macOS the standard Quit menu item terminates without an exit event Rust can hold, so the app menu has its own Quit item (Cmd+Q) that starts the handshake, as does Quit Devot in the menu bar icon's menu; closing the last main window shown (Cmd+W or the close button) is held the same way, or in menu bar mode hides the window and quits nothing (see Menu bar mode); closing one of several main windows quits nothing (see Several main windows).
  Quitting from the Dock or at logout still bypasses it, and autosave bounds the loss to the last 300 ms (2 s for a note of 1 MB or more).
- `scripts/smoke/quit-saves.sh` checks both paths on the real app (types, quits at once, reads the database).
  It runs the debug bundle on the debug builds' data folder (see App data folder), needs Accessibility permission for the terminal and switches the keyboard to ABC while it runs, because an input method rewrites simulated keystrokes.

## Note windows

- **What:** a note in a window of its own (#3), beside the main window: Shift+Return on a row of the note list, Open in New Window in the note menu, or the palette for the open note (`note.openInWindow`; not for templates or several notes).
  The main window saves its edits first.
  Opening a note that has a window brings that window forward; a note link clicked in a note window opens that note in its own window.
  Desktop only (`src-tauri/src/note_window.rs`, `cfg(desktop)`); a phone has one window.
- **The window** (`note.html`, `src/renderer/src/noteWindow/NoteWindow.tsx`): the title, the editor and the view modes (write, edit, split, preview; it opens in the install's default, see Write mode), on an opaque window named after the note.
  The window's label is `note-<note ID>`, so Rust knows its note from the label alone (`note_window_note`) and the page can ask for no other.
  Its capability (`capabilities/note-window.json`) grants what one note needs: reading, searching and writing notes, their versions and attachments, reading the notebooks (a note a `[[` link makes goes in the same notebook) and purging the empty note a link made and dropped, the relay and its own close; no notebook or tag changes, imports, exports, backups or settings changes, which stay in the main window.
  Menu commands (Format, View) still act on the main window.
- **Size and position:** each note's window opens where it was last, at its size: Rust keeps the frames of the last 100 note windows (moves and resizes are kept in memory, written to `<app data>/note-windows.json` when a note window closes and when the app exits; a local preference, read leniently, never synced).
  A frame whose title bar is on no screen now is not used; a note without one opens beside the main window, 720 x 780 points.
- **Closing saves first,** as quitting does: Rust holds the close, sends the window `devot://note-window-close`, and closes it when the page has saved (`note_window_close_ready`), or after 2 s.
  The page hears closes and quits from the start, and a window still opening, or one that could not open its note, answers at once: it has nothing of its own to save.
  When the save fails, the first close is called off (`note_window_close_cancel`) and the window's notice says that closing again closes it without the changes.
- **One note, two cores** (`src/core/noteRelay.ts`): each window runs a core of its own, which holds a Yjs copy of the note.
  Every change a core makes to a note's document (typing, which comes as the editor's updates, and its own edits and merges) is relayed at once as the Yjs update it made, and a title change as the title and its HLC.
  A core that reads a note in sends its state vector (`want`), and every core that holds the note answers with what it lacks, so a window opened after the other typed starts with the unsaved typing (a note window listens to the relay before it reads its note, so the answer cannot arrive unheard).
  The receiving core applies what it is sent (`NoteService.receive`) and tells its window (`onTakenIn`), whose editor takes it in as a change from outside (not undone by Cmd+Z), and its title field the title.
  Yjs merges updates in any order, so delivery may lag or reorder.
  Each window saves its own changes: a relayed change is not a pending edit of the window it reaches, which also keeps no version or baseline of it (the window that made the change does).
  Saves merge into the stored state rather than replace it: two windows writing the same note are two writers on one body version, so the second write is refused (`E_NOTE_BODY_STALE`), takes the stored copy in and writes again (see Body versions), and what it takes in reaches its editor too.
  Each write is relayed as `saved` with its date, so the main window's lists move the note without a reload (a note made in a note window, through a `[[` link, reloads them).
  `tests/core/note-windows.property.test.ts` types into one note in two windows at random, with deliveries late and reordered and saves at any time, and checks that both windows and the stored note end with every edit either made; `tests/core/lineage.test.ts` checks that two windows' edits keep the note's lineage.
- **The note relay** (`src-tauri/src/note_relay.rs`, `note_relay_send`): the page hands Rust what its core sends (Yjs data stays the base64 the worker coded, never decoded), and Rust checks it (a note ID, base64 within a Yjs state's limit, a title within the title limit, an HLC) and passes it to the windows that may show the note: every main window, and the note's own window; each page listens on its own window only.
  A main window sends a note's changes only once another window has spoken of the note (`relayGate` in `src/renderer/src/noteRelayWire.ts`; a note window always sends, `relayAll` when its core starts), so a window alone pays nothing for each keystroke.
  The worker applies that rule before it codes a message (`relayOut`): a change no other window listens for is never coded or posted to the page, and a message the page relays in (`relayIn`) marks its note as spoken of.
  A note window's core leaves compaction and the notebooks' order to the main window's.

## Several main windows

- **What:** File > New Window (Shift+Cmd+N, or New Window in the palette) opens another main window (#9), as many as 12 at a time.
  Each has its own library view (starting at All Notes), open note, selection, scroll position, focus mode, sidebar and size, and a core of its own on the one library.
  Desktop only (`src-tauri/src/main_windows.rs`); a phone has one window.
  A new window opens at the size of the frontmost one, a little down and to the right (`CASCADE`, 32 points), or centred when that would leave its title bar off every screen.
- **Labels and permissions:** the first window is `main` and the others `main-<n>` (2, 3, ... in the order they are made, never reused in a run).
  `is_main` in Rust and `isMainLabel` in the page tell them from every other window, and they share one capability (`capabilities/main.json` names `main` and `main-*`), so each has what the main window has.
  A window other than `main` keeps its view preferences (the last state, focus mode, the sidebar) in the webview's session storage, which goes with the window and survives its reloads, so a later window with the same label starts fresh; `main` keeps them in local storage as before (see Restoring the last state).
- **The frontmost main window** is the one focused last of those shown (a minimized window counts as shown), else the one focused last of all, so it follows the user (`front_label`).
  What belongs to one window of the user's choice goes to it: the View, Format and Revision History menu items and the palette, Backups, Export All, Rebuild Search Index, the HTTP API's calls and quick capture's notes, a deep link, and the files the `devot` command hands over (which also bring it forward); import dialogs hang off it, and an import's events go back to the window it began in (the frontmost one if that window is gone).
  A note-less event for all of them (an outside change found in the database, a failed backup) goes to every main window.
  The Text Look Up, Speak and editor context menu popups open in the window that asked, not in `main`.
- **What runs once** runs in `main`: the Markdown mirror (the other windows' writes reach it as writes from outside, see below), compaction and the order of notebooks.
  A core of another main window is lean, as a note window's is (`lean` in `init`).
- **Closing:** closing a main window quits Devot only when it is the last one shown (and menu bar mode is off, where it hides it instead).
  With another main window shown, closing `main` hides it (it hosts the mirror and holds unsaved edits, so it stays alive), and closing any other main window saves it and closes it, the way a note window closes (`close_after_saving`, `note_window_close_ready`, `note_window_close_cancel`; the first close whose save fails is called off and the window's notice says so).
  Only `main` runs the sync engine (`runsSync`), for the same reason: Rust holds one socket, and `main` stays alive while the app runs.
  A hidden `main` comes back with Open Devot in the menu bar icon, the Dock icon, or when no other main window is shown and a link comes in.
- **Quitting saves every window:** a quit asks every main window, hidden ones included, and every note window to save and waits for all of them (`savers_among` in `exit.rs`); a window the quit called off for (its save failed) is the one shown, if it was hidden.
- **Consistency:** two main windows on one note are two cores and two editors on it, kept together by the note relay as a main window and a note window are (the relay reaches every main window; a main window sends a note's text once another window has spoken of it, and a core that reads a note in always asks, so two windows that both have a note open start sending to each other).
  Everything else a window writes (a status, a pin, a notebook, a tag, a note made, trashed or purged) reaches the other main windows' lists by `devot://lists-changed`: a window that wrote tells Rust (`main_windows_changed`) 250 ms after the first write of a burst, Rust tells the other main windows, and each loads its lists and merges what is stored into the notes it holds 400 ms after the news, the way it does for a change another process made (`DB_CHANGED`, `externalChanges.ts`).
  The merge is field by field on the notes' HLCs, so a window's later save never undoes another's change (`tests/core/main-windows.test.ts`).

## Merging and history

- Concurrent edits merge automatically.
- When a sync brings in offline edits made on both sides, Revision History keeps the local text from before the merge, labelled as such, and can restore it (see Revision history).
  _Later:_ the note shows a notice ("Merged offline edits from iPhone · View changes") that opens the diff.
- Every note keeps version history (Yjs snapshots); see Revision history.
- **Undo** (#186): the editor has one undo system, CodeMirror's history (`history()` in `src/renderer/src/editor/settings.ts`, the rest in `editor/undo.ts`); there is no Yjs undo manager (`yCollab` gets `undoManager: false`), so no deleted Yjs items are kept alive for undo.
  Cmd+Z and Shift+Cmd+Z (CodeMirror's history keys) and Edit > Undo and Redo (they reach the page as `historyUndo` and `historyRedo` input events, which the history takes) all go to it.
  - It holds only the user's own edits in this editor.
    A change that reaches the editor from its Yjs document (sync, another process or the Markdown mirror, the core merging what was stored) is applied without entering the history (`Transaction.addToHistory` false, added by a transaction extender to every change y-codemirror brings in): undo never takes it back, and the history maps its steps through it, so it never joins the typing around it.
    Edits that arrive from AI (`update_note`) are not undone by it either.
  - Each editor command (a format from the toolbar, the Format menu or its key, a slash menu item, a table command, Replace, New Note from Selection) is one step (`isolateHistory`); so is an image pasted or dropped, which lands a moment later, apart from typing done meanwhile.
    An input method's composition is one step however long it takes (the history always joins `input.type.compose` changes).
  - A restored version is the user's own change: one step of its own (see Revision history).
  - **Per note:** leaving a note keeps its history with its text and its replica's Yjs state (the last 10 notes left, `UNDO_NOTES`); shown again, the Yjs changes the core's document has beyond that state are applied outside the history, each where it was made (as y-codemirror applies a change while the note is open, never one text difference over everything between them), so undo goes on with the user's own edits in their places and leaves what changed meanwhile.
    When the core's document does not hold the kept state (it was made anew) or those changes do not lead to its text, the note starts with no history.
    The history lives in the window, not in the core, so the core letting the note go from memory does not touch it; a note left longer ago, or a reload of the window, starts with no history.
    Typing after coming back is a new step.

## Revision history

- **Storage:** the `revisions` table (schema v9).
  A body version holds the note's whole Yjs state (`Y.encodeStateAsUpdate`, not `Y.snapshot`: documents are garbage-collected, so a snapshot could not rebuild old text), its length in characters and, from schema v24, its word count; a metadata event holds the new title, notebook ID (null for none), status or pinned flag.
  Revisions are local to this device: they carry no HLC and are not synced (ADR 0002).
  Before a state from another device changes a note's body, and before another device's purge removes a note, the sync engine keeps the local body as a version with `value` 'merge' (`MERGE`); Revision History labels it "Before a merge with another device", so either side of an interleaved paragraph can be restored, and compaction keeps it.
  When both bodies held changes the other lacked, the version is always kept; when the change came only from the other device, at most one every 10 minutes (`REVISION_EVERY_MS`, a body version taken here counts), the rate typing here takes versions at, so a note typed on another device does not leave a never-compacted version per push.
  A welcome note nobody edited that gives way keeps none.
  A purge that came through sync keeps the note's revisions (`syncPurge`); a purge made here deletes them.
  Purging a note deletes its revisions; the Trash keeps them.
- **When a version is taken** (the core note service, `src/core/notes/versions.ts` and `src/core/revisions.ts`): once editing pauses for a minute, and at least every ten minutes while editing goes on.
  A version with the same text as the newest one is skipped.
  Leaving a note takes no version: the saved body is the latest text, and the first change to the note in a later session (an edit, or a title, notebook, status or pin change, saved before it moves `updated_at`) keeps it as a version dated when the body was saved, unless the history already ends with it.
  For a note without history, that version is its baseline (`value` 'baseline'): the text it arrived with (an import, an AI tool, a duplicate) or had from before history existed, kept without writing a version for every imported note.
  An accepted AI edit takes a version of the text it replaces and then one of the text it leaves, marked as AI's (`value` 'ai', `AI_EDIT`): its authorship.
  Quitting, moving a note to the Trash and opening the Activity sheet take a version of typing that has none yet.
- **Events:** title, notebook, status and pin changes are recorded when they are saved locally; quick title edits (within a minute of each other) update one event, which goes away when they end at the title they started from.
- **Compaction** keeps every version from the last 24 hours, the last of each hour for a week, the last of each local day before that, and always a note's ten newest versions (`KEEP_NEWEST`), whatever their dates; events, baselines and AI versions are small or needed, and kept (only plain versions, `value` null, are ever dropped).
  Ages are measured by the system clock, from now or from the note's newest version, whichever is earlier: the spacing between versions taken at real times decides, so a clock running fast (a session a day or more ahead, which makes the latest work look old) cannot thin a note's last day of work, and the ten newest versions bound what it can thin of a note with a version taken while it ran fast.
  A note whose newest version is dated after now (the clock was set back since it was taken) is left alone until the clock passes it.
- **Sweeps:** a sweep runs after a save of any note, at most hourly, so notes that are no longer edited are thinned too.
  It runs on a queue of its own: switching notes, the Trash, History, Activity and quitting never wait for it.
  The time of the last sweep is kept in the database (schema v13 `compaction`, one row), so a sweep, the first of a session too, looks only at notes with a version that has turned a day or a week old since the sweep before (`compactionWindows`), the only ages at which the policy keeps less; when no sweep ran yet, or the clock was set back past the last one, it looks at every note with more than one version older than a day.
  Storage lists the plain versions (baselines left out) of those notes 500 notes a call (`listCompactable`, command `revisions_compactable`), from covering indexes (schema v13 `revisions_history`, which history lists read too, and `revisions_by_time`): it scans only the window's versions and each listed note's, never a Yjs state.
  The dropped versions are deleted as the pages come, in calls of at most 200 (`compactRevisions`, command `revisions_compact`, which deletes only plain body versions); the last call records the sweep's time, so an interrupted sweep runs again.
  Restoring a backup first holds compaction (`holdCompaction`): no sweep starts, and the restore waits for a running one to finish, so a sweep never deletes from the restored database what it chose from the old one, nor records its time there (a restore from another main window holds `main`'s through Rust, see Backups); the window reloads after the restore, and a failed restore lets sweeps start again (`resumeCompaction`).
  Measured on 10,000 notes with 20 versions each (better-sqlite3, M1 Pro): a page takes about 95 ms and 1.1 MB the first time every note is weighed, and an hour's window about 15 ms.
  Tests check that the Rust and TypeScript statements are the same, their query plans, and that the UI tests' memory adapter answers like SQLite.
  The AI service never compacts (see AI).
- **Restore** computes the text difference from the current body to the version and applies it through the same path as `NoteService.setBody`, as one Yjs transaction; the version's state is never written back.
  Unsaved edits become a version first.
  The core returns the transaction's update; the editor applies it to its replica as one undo step of its own (`isolateHistory`), not joined with typing just before or after, so Cmd+Z takes back the whole restore and Shift+Cmd+Z brings it back.
  A restore is an edit like typing: undoing it is a new change the core saves.
  A restore made while the note is not in the editor reaches it as a change from outside, which undo does not take back.
  An image the version shows whose attachment was purged meanwhile does not come back (see Purging attachments).
- **UI:** the Revision History sheet (`RevisionHistory.tsx`) opens from the note context menu, the editor toolbar's More menu and View > Revision History… (Option+Cmd+Y).
  It lists versions (time, characters added or removed since the version before; the oldest kept version, which has none before it, reads "Earliest version" with its length; an AI version reads "Edited with AI" before its change) and events, newest first, as a keyboard-navigable listbox.
  Selecting a version shows a line diff (`src/core/diff.ts`, Myers' algorithm, unchanged runs folded) of the changes in the note since that version, with Restore.
- **History bar** (`HistoryBar.tsx`, `historySteps.ts`): View > Show History Bar (the `historyBar` editor setting, off by default; Rust toggles it and relabels the item Hide History Bar, and the palette has the same command) shows the open note's kept body versions along the editor's bottom edge as ticks on a time axis from the oldest version to now, each tick's height the square root of its characters changed.
  The handle is an ARIA slider with one tab stop: its steps are the versions, oldest first, and then the current text, each named by its date and totals ("Earliest version", characters added or removed).
  Dragging the handle shows the version under it while the button is held, and letting go returns to the current text; a click on the bar or a slider key (arrows, Page Up and Down, Home, End) keeps the version shown until Escape (pressed in the bar or the overlay), End or another note.
  A shown version is a read-only overlay over the editor (and the preview beside it), never a change to the note, and the panes under it are inert while it shows: the current text with what changed since that version (`inlineDiff` in `src/core/diff.ts`, the line edits split into words), removed text struck through, added text highlighted, the rest dimmed, and the version's date on the handle.
  The overlay is drawn from the editor's live text, so an outside change (sync, an AI tool) while a version shows appears in it at once.
  Selecting struck text (or tabbing to a struck run, which takes it in whole) offers Restore This Passage (`NoteService.restorePassage`): the removed text the selection takes in goes back where it stood (`passageInserts`, before any text that replaced it; text the note still has is left alone) as one edit, one undo step, with the text before and after kept as versions; Restore Whole Version is Revision History's Restore.
  Once a version is over a day old, the bar says that compaction keeps one version per hour for a week and one per day before that.
- **Word and character counts** (`src/core/noteCounts.ts`, `editor/counts.ts`, `CountsFooter.tsx`): one rule for the Mac footer and the phone's note info (`phone/noteStats.ts`): the count is of `readableText`, so front matter, the Markdown of links and images (their label and alt text stay) and bare marks are left out, each CJK character is a word, and characters are those other than whitespace.
  The editor reports counts through a debounced pacer (300 ms after the last edit or selection change; the whole note is counted again only after a text change, the selection from its own text; the core worker counts, so a long note's count never holds a frame, and an answer for text changed since is dropped), and only while the footer is shown (`showCounts`, Settings > Editing; Mac only).
  The footer and Note Info share one count of the whole note per text (`tallyNote` in `src/renderer/src/noteTally.ts`, the worker's `noteTally`: words, characters and tasks), so a pause sends the note to the worker and counts it once.
  Counting reads each character by its code (ASCII, JavaScript's whitespace, the CJK ranges) and asks Unicode only whether a character past ASCII is a letter or digit; `src/core/noteCounts.test.ts` and `words.test.ts` hold it to the rule as first written, one regular expression per character, on text of CJK, emoji, combining marks and lone surrogates.
  With a selection the footer reads `12 of 340`.
  The activity figures count words the same way (`noteCounts`), so a week's words match what Note Info shows.
  Versions stored before that counted the raw text, so a note's first version after it can move its day's words by the difference, once.
  That change can be negative, for a note whose raw text held more words than it shows.
- **Outline** (`src/renderer/src/outline/`): View > Show Outline (the `outline` editor setting, off by default; a check item in Rust's menu, and the palette has the same command) puts a column of the note's headings at the right edge of the panes (`OutlinePanel.tsx`).
  The headings come from `outlineEntries` (the palette's outline) filtered to headings, rebuilt only when the text changes, nested by level; their fold state is kept per note for the window's life, keyed by level, text and which of that pair it is.
  The heading marked is the last at or above the caret's line (editor and split) or the preview's top line (Preview).
  Choosing one (click or Return) puts the caret there without taking the keyboard from the outline (`goToLine`'s `focus` flag) and scrolls the preview when it is shown; Escape returns to the editor.
  It is not shown in focus mode, nor when the panes' width cannot give it `size.outline-width` and each pane `size.pane-min-width`.
  The main window and standalone note windows show it; a note window has one note, so its fold state is not keyed.

## Activity heatmap

- **What it shows:** View > Activity… (no shortcut) opens the Activity sheet (`src/renderer/src/Activity.tsx`): the last 52 weeks as a grid, weeks as columns, Monday first (ISO weeks; the current week is the last column, days after today are blank).
  Each square is a day, shaded from five theme colours (`color.activity.level-0` to `level-4`, light and dark) through CSS classes; a summary, a legend and a footnote go with it.
  Nothing is uploaded and no new data is recorded: it is counted from the notes and the revision history already on this device.
- **What a day counts** (`src/core/activity.ts`): notes created (`created_at`); notes edited, each once (a body version or a title change); and characters changed: for each body version taken that day, how far the note's text length moved from its version before (from empty for its first).
  Opening the sheet first keeps typing that has no version yet as one (`NoteService.activity`), so it counts at once, and quitting does the same, so it counts on the day it was typed.
  Notebook, status and pin changes are not writing and never count, nor move a count: a version they lead to is dated by the body's own last save.
  Text a note had before its history began (an import, an AI tool, a duplicate, a note from before history existed) is never counted: its baseline is not activity, only the version the next one is measured from.
  Typing a crash left out of a version counts on the day of the body's last save, once the note is changed again; typing a crash lost on a note without history is not counted.
  Notes in the Trash count; purging a note removes its activity with its history.
- **Honest about compaction:** history keeps every version from the last day, one per hour for a week and one per day before that (and each note's ten newest versions), so older days may count only each note's net change over the day (typing 500 characters and deleting 400 shows 100), and never more than was typed.
  The sheet says so.
- **Days and zones:** a day is the local calendar day of the system time zone: an instant's day is its wall-clock date there (`localDay`, from the zone's offset at that instant), so DST days of 23 or 25 hours and zones such as +05:45 need no special case.
  Compaction uses the same day.
  Unit tests inject the zone (Los Angeles across both 2026 transitions, Shanghai, Kathmandu).
- **Shades:** an idle day is level 0; a day with activity but no characters changed is 1; otherwise a day's level is its percentile rank among the days that changed characters, in four steps, so the busiest day is always 4 and one huge import does not wash out the rest.
- **Storage:** `listActivity(since)` returns the notes created since then and the body versions (baselines left out) and title changes taken since then, each body version with the length of the note's version before it (a baseline included) (ordered by time, then length, then storage order).
  The Rust store (`activity_list`), the better-sqlite3 adapter and the UI tests' memory adapter implement it; a test checks that the Rust and TypeScript statements are the same and that the memory adapter answers like SQLite.
  Migration 0012 adds covering indexes (`notes_created`, `revisions_by_time`, `revisions_activity`), so counting reads only the year in view and never a Yjs state; a test checks the query plans, and a benchmark keeps 10,000 notes with history under 250 ms.
- **Activity strip in the note list** (`ActivityStrip.tsx`, `buildStrips`): each row shows its note's last 14 local days (today last) as small squares in the same five colours, named for assistive tech by its active days, each square titled by its date and totals; Settings > General > Show Activity in the Note List (the `activityStrip` editor setting, on by default) hides it.
  A note with no edit in its 14 days shows no strip.
  The strip ends the row's meta line, which stays one line: what does not fit is cut, never wrapped under the strip.
  A day counts the note's body versions and title changes as the heatmap does, and typing not kept as a version yet counts today, without taking a version.
  Shades are fixed steps, not percentiles, so a day keeps its shade as rows scroll in and out: level 1 for a day with activity, then 2, 3 and 4 from 100, 500 and 2,000 characters changed.
  Rows read their strips with their excerpts, in one read so a change renders a row once (`withStrips`; the rows rendered only, again when a note's `updated_at` moves), through `listNoteActivity(ids, since)` (command `activity_notes_list`, at most 500 IDs a call like `notes_bodies`): the same columns as `listActivity`'s versions, from schema v13's covering `revisions_history` index, so it reads the 14 days of the notes asked for and never a Yjs state.
  A test checks the Rust and TypeScript statements match and the query plan; a benchmark keeps 60 rows of a 10,000-note library under 10 ms and 500 rows proportionally.
- **Words (schema v24):** each body version stores its word count (`revisions.words`, the words of `noteCounts` in `src/core/noteCounts.ts`, the same count as Note Info), written by the same statement as the version and checked in Rust (not negative, not above the version's length; null on an event).
  `listActivity` and `listNoteActivity` also return it and the previous version's (`previousWords`), from the same covering indexes, which v24 rebuilt with the column; versions that tie on time and length now order by words before rowid, so the index can give the order without sorting.
  A version from before v24 has null, and nothing is backfilled, since that would mean reading every Yjs state: it counts no words, and neither does the first version taken after it, whose change is unknown (counting it from empty would credit the note's whole text to that day).
  Days and weeks before the upgrade therefore show as level 1 on the phone's heatmap when they had activity, and word figures fill in as notes are edited.
  A note's first version ever counts from empty, as for characters.
  The Mac's sheet still counts characters.
- **On the phone** (`PhoneActivity.tsx`, `buildWriting`): the last 15 weeks, shaded by words changed (percentile among those days, as above); for this week and last week, words changed (each version's distance from the one before), the day streak (days in a row with a note created or edited, ending at the week's end; an empty today does not break it; read from the 52 weeks loaded, so it stops there), notes edited, and the notes ranked by net word growth (those that did not grow are left out).
  The screen lists only notes in the library, so a note in the Trash or a template is not ranked, though its words count.
- **Keyboard and assistive tech:** the grid is an ARIA grid with one tab stop (today when it opens); arrow keys move a week left or right and a day up or down, Home and End go to the first day and today; up and down stay within the day's week.
  Each day's square is named by its date and totals (from the catalog), which a line under the grid also shows for the day under the pointer or in focus.
