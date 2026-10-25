# Authorship is recorded in the note's Yjs document, by the item IDs each agent write changed

Every agent write (devot-mcp, the local HTTP API, an accepted Edit with AI proposal) adds a record to two maps in the note's own Yjs document, beside the body text. The record says who wrote, when, which Yjs items the write inserted and deleted, and what text it deleted. Text is attributed by its item IDs. Those IDs do not change through merges, sync, garbage collection or a restart, so the records need no anchors and no merge rule of their own. They sync with the body as part of the note's record (ADR 0002). Undo All reverses one writer's records from those IDs. Whether the owner has seen a write is kept on each device, in a derived index. This settles the storage question of #372.

## What exists today

- A body is one `Y.Text` (`body`) in a Yjs document per note. Storage replaces the whole state on each write; there is no update log (ADR 0002). Documents are garbage-collected: when a transaction ends, the content of deleted text is dropped, and only its IDs and length remain.
- devot-mcp and the local HTTP API write through the core's AI service. The new text goes in as Yjs operations (`textEdits`), in one storage transaction. devot-mcp's HLC node ID is random per process (`mcp…`). The MCP client gives its name in `initialize` (`clientInfo`).
- An accepted Edit with AI proposal goes in through `NoteService.applyAiEdit` and leaves a body version marked `ai` (#340). That is the only authorship today, and it lives only in this device's Revision History.
- A Yjs transaction origin lasts only as long as the process that made the transaction. The editor has no Yjs undo manager (#186).

## Where authorship lives

- **Two root maps in the note's Yjs document**, next to `body`:
  - `writers`: session ID → `{ v: 1, kind, name, process }`;
  - `writes`: write ID → `{ v: 1, writer, at, ids, removed?, fields?, created? }`.
  - Both IDs are 64 random bits in base64url.
- **A writer** is one session of one client:
  - `kind`: `mcp`, `http` or `aiEdit`. Devot sets it; the client never does.
  - `name`: the MCP `clientInfo.name` as the client gave it, made one line without control characters, at most 100 code points. It is '' for the HTTP API and Edit with AI, which show their kind instead. A name is only shown; it never grants access.
  - `process`: the HLC node ID of the process that wrote. devot-mcp makes a new one for each run; the app uses the device's.
  - The key is the session. There is one session for each MCP `initialize` (over stdio, one per process), one for each start of the core that answers the HTTP API (the main window's, which does not hear Rust start or stop the listener), and one for each Edit with AI sheet.
- **A write** is one tool call, request or accepted proposal:
  - `writer`: the session key;
  - `at`: the wall-clock time in ms;
  - `ids`: varuints: the clients its ranges name, the count of inserted ranges, then each `(client's place in that list, clock, length)` range, first those it inserted into `body`, then those it deleted. A client ID takes five bytes and a write's ranges name few clients, so each is written once;
  - `removed`: the text it deleted, in the order of its deleted ranges, so Undo can put it back after garbage collection has dropped it. The write helper reads the text before it deletes it;
  - `fields`: the metadata it changed (`title`, `notebook`, `tags`, `status`, `trash`), for the notice and the list;
  - `created`: the write made the note.
- **One write is one Yjs transaction:** its body operations and its record are stored, relayed between windows and synced as one update. No stored state holds a write's text without its record.
- **Attribution:** a character is an agent's when its item ID falls in a write's inserted ranges; all other text is the owner's. An ID stays the same when Yjs splits or joins items, when it collects garbage, and on every device.
- **The gutter** reads the editor replica's own document, which holds both maps, so it needs no new command.
- **Records are untrusted input:** they can come from another device, devot-mcp or a later version. A reader skips a record that does not parse, or one with a `v` it does not know, and keeps it in the map (`W_AUTHORSHIP_RECORD_INVALID <noteId> <writeId>`).

**Rejected:**

- **Transaction origins in an update log.** Origins are never stored, so recording them means keeping each update with its origin. That is the update log that ADR 0002 and the data model chose not to have. Each Yjs update also carries the document's whole delete set, so the log grows fast: 26 KB for 50 writes and 674 KB for 500 (Cost), and it needs a compaction protocol that keeps attribution.
- **Text attributes (`Y.Text` formatting).** This is the smallest option (2.6 KB for 50 writes) but fails in other ways:
  - In Yjs an insert without attributes takes those at its position, so the owner's typing inside or after agent text through y-codemirror would count as the agent's.
  - The attributes are items in the text that every binding sees.
  - Clearing them is more formatting operations, which stay as tombstones.
  - An attribute holds only a key, so the writer, the time and the deleted text still need a record elsewhere.
  - Deleted text leaves nothing to undo from.
- **A table in SQLite, synced as a new field of the note record.** It holds the same bytes, but needs its own merge rule and an HLC for clearing, a change to the sync format, the same schema in three storage adapters, its own relay between windows, and a write in devot-mcp's transaction. The editor replica could not read it from its document.
- **An undo manager scoped to the agent's origin.** Its stacks live in memory in one document. They are gone after a restart and do not exist on another device. devot-mcp's writes reach the app as stored states with no origin at all.
- **Keeping deleted content in the document** (garbage collection off, or a `gcFilter`). Garbage collection off keeps every deletion ever made, the owner's too, in every note. A filter works only while every document in every process and version applies it: a build without it drops the content on its next write.
- **A fresh Yjs client for each write, as the writer's ID.** It costs almost nothing (about 3 bytes a write), but devot-mcp's note service can keep a note's document between calls, and the core's document also makes restores and template appends. Ranges work whatever client wrote.

## Merges, compaction and sync

- **Merge:** the maps are Yjs types, so applying both states unions them. Write and session keys are random, so two writes never share a key. Item IDs are the same on every device.
- **Sync:** the maps are part of the record's Yjs state, so there is no new field and no format change. The fingerprint (`bodyPrint`) already covers the whole document, so a new record makes a push. Older builds keep root types they do not know and pass them on.
- **Restart:** the maps are stored with the body.
- **Revisions and compaction:** a body version holds the whole state, maps included. Compaction never reads a state (`listCompactable` works from indexes), so it does no extra work, but each kept version weighs what the maps weigh (Cost).
- **Copies:** Duplicate copies its source's state, so the copy keeps the authorship. New Note from Selection and import start a new lineage without any. Restore and templates are the owner's edits.

## Undo All and Review Changes

- **Reversal from the recorded IDs**, as an owner edit through the core, like a restore. For each of the writer's writes on the note, newest first:
  1. Put `removed` back where its first deleted item sits; the tombstone keeps its place in the text after garbage collection.
  2. Delete every live character in its inserted ranges.
  3. Delete its entry from `writes`.
  - The owner's text typed inside the agent's text stays, and so does every later edit elsewhere and every other writer's text.
  - The editor applies the change as one undo step (`isolateHistory`), so Cmd+Z brings it back.
- **Undo All works per writer** (kind and name, across sessions) on the open note. When several writers changed the note, the notice offers one Undo All for each.
- **Review Changes** steps through the runs of each write in document order: an inserted run, a deletion point, or both side by side. The editor scrolls to each one and selects it.
  - Keep moves on. Once every step of a write is kept, its `removed` text is dropped, since there is nothing left to put back.
  - Undo reverses that step alone (`E_AUTHORSHIP_STALE` when the step changed under it).
  - Next, Previous, Keep and Undo have keys and are in the notice's tab order. Each gutter mark has an accessible name ("Written by <name>, <time>").

## Since the owner last looked

- **A derived local index**, `agent_writes (note_id, write_id, kind, name, at, created, seen)`, added by a migration.
  - The core derives its rows from the document and storage writes them with each note, as it does `bodyMd`. This holds in the Rust store, the better-sqlite3 adapter and the UI tests' memory adapter alike, and devot-mcp writes them in its own transaction.
  - It is never synced and never the source of truth. A missing row is derived again.
- **Seen:** a row starts unseen the first time this device derives it. `aiEdit` writes start seen, since the owner accepted them. Leaving a note shown in an editor, or closing its window, marks every write it showed as seen.
- **The list mark** shows on a note with an unseen row, with "changed by <name>" for the newest. **The sidebar's Agents section** lists recent `mcp` and `http` rows by writer name, newest first, with their unseen counts. Purging a note deletes its rows; the Trash keeps them.
- **Rejected: seen state synced in the note record.** Each look at a note would push the whole record (ADR 0002 pushes the full state) and would need an HLC field of its own. Because seen is local, a note seen on one device still shows as changed on another.

## Clearing and logs

- **Clear Authorship** (note context menu and More menu) deletes every entry of both maps in one transaction.
  - Garbage collection drops the records and their `removed` text straight away; only tombstones remain (about 35 bytes a write).
  - The clear merges to the other devices like any change. A write made elsewhere that the clear had not seen stays.
  - A write sets its writer's entry only when the note lacks it or it changed, so a write the clear had not seen, from a session whose entry the clear deleted, has no writer and counts as cleared. The session's next write sets the entry again and brings it back. Writing the entry with every write would avoid this but costs about 15 bytes a write more.
- **Local copies:** versions in Revision History taken before the clear keep their copy of the maps. They are local, never synced, and they already hold that text as body text.
- **Logs** carry codes, note IDs, write IDs and kinds. They never carry a client name (text another program chose), body text or `removed` text:
  - `I_AUTHORSHIP_WRITE <noteId> <writeId> <kind>`;
  - `I_AUTHORSHIP_UNDONE <noteId> <count>`;
  - `I_AUTHORSHIP_CLEARED <noteId>`;
  - `W_AUTHORSHIP_RECORD_INVALID <noteId> <writeId>`.
- **Errors** are codes too.

## Cost

Measured with a script on yjs 13.6.33 (Node 26, M1 Pro):

- **The note:** 5,058 words typed one word at a time over 20 sessions, a Yjs client each, with corrections: 26.8 KB of state.
- **The agent writes:** 50 writes by two MCP clients, each in a fresh document as devot-mcp loads a note. Each write replaces a sentence, inserts a paragraph or deletes a sentence: 2,388 characters deleted in all, in 58 ranges, and 34 inserted ranges.
- **The owner's edits:** after each write, the owner types inside the agent's text and somewhere else.
- **Without authorship** the state is 34.6 KB.

| Option (50 writes)                                                  | Added to the stored state                |
| ------------------------------------------------------------------- | ---------------------------------------- |
| **Chosen:** two maps, packed IDs, `removed` text                    | 6.3 KB (+18%), 2.4 KB of it deleted text |
| The same records as plain JSON objects in one map                   | 16.0 KB                                  |
| Text attributes (still needing records elsewhere)                   | 2.6 KB                                   |
| Garbage collection off (grows with every deletion, the owner's too) | 2.4 KB                                   |
| Update log of the 50 updates                                        | 26.4 KB                                  |
| After Clear Authorship (tombstones)                                 | 1.7 KB, no deleted text left             |

- **With 500 writes** on the same note, the state without authorship is 109 KB:
  - the chosen records add 57.6 KB (+53%; about 80 bytes a write plus the text it deleted);
  - an update log adds 674 KB and takes 32 ms to merge;
  - Clear Authorship leaves 16.7 KB.
- **Revisions:** each kept body version weighs the same 6.3 KB more, since it holds the whole state. Compaction reads no state, so its time is unchanged.
- **Time** (without authorship, then with it, where it differs):

  | Step                                           | 50 writes          | 500 writes         |
  | ---------------------------------------------- | ------------------ | ------------------ |
  | Reading the state                              | 0.4 ms (unchanged) | 2.3 ms (unchanged) |
  | Writing the state                              | 0.17, then 0.22 ms | 0.74, then 1.3 ms  |
  | Attributing the whole note (the gutter's walk) | 0.06 ms            | 0.23 ms            |
  | Undo All for one writer                        | 0.8 ms             | 4.6 ms             |

- **Measured again on the implementation** (`tests/core/authorship.bench.test.ts`, random 32-bit Yjs clients and millisecond times, as the app writes them): the same kind of note is 48.5 KB with 50 writes and no authorship; the records add 7.3 KB (+15%), 2.6 KB of it deleted text, about 95 bytes a write besides; Clear Authorship leaves 1.6 KB. The test keeps the share under the 18% above.
- **Undo All checked:** after a merge with another device's edit, Undo All for one writer left none of its characters. It kept all 50 owner edits, the other writer's 2,734 characters and the other device's text. The merged copy attributed the same 5,665 characters as the original.

## Risks

1. **Cut and paste.** Moving agent text by cut and paste makes it the owner's: the pasted text gets new items. A restore that brings back agent text makes it the owner's too. Both are the owner's own actions.
2. **Owner text inside agent text.** Undo All keeps what the owner typed inside text it removes, so a word or two can be left on its own. Review Changes shows these places first.
3. **Growth.** A write costs about 80 to 95 bytes plus the text it deleted. `removed` text is capped at 1 MiB per note, dropped oldest first. Undo of a write whose `removed` text was dropped takes out only what it inserted, and the notice says so. Clear Authorship gives most of the space back.
4. **Spoofed names.** A client can call itself anything. Devot sets the kind, and the UI always shows it with the name ("Claude Code, MCP"), so a client can never look like Edit with AI or the owner.
5. **Yjs internals.** Attribution and reversal walk a text's items (`_start`), as the welcome note merge does already (`dropClient`). yjs is pinned, and the tests cover the walk on each upgrade.
6. **Revisions weigh more.** A kept version holds the maps. Clearing does not shrink versions already taken.
7. **Undo All on two devices offline.** If both devices undo the same writer before they sync, both put the deleted text back, and after the merge it shows twice. The pre-merge version restores either side (ADR 0002, risk 2).
8. **Seen is per device.** A note seen on one device still shows the mark on another.

## Consequences

- **No change to sync:** no record format change, no new relay data and no Rust Yjs code. Every body write keeps going through `textEdits` (ADR 0002, risk 1).
- **`docs/architecture.md`:** AI points to this ADR. When the work ships, the Data model gains the two maps and `agent_writes`.
- **Tickets for #372, in order:**
  1. Core: `src/core/authorship.ts`, holding the records, the ID packing, attribution, reversal and clearing. The AI service (devot-mcp and the HTTP API) and `applyAiEdit` record their writes. Tests on real SQLite cover interleaved edits, restart, compaction and a sync round trip.
  2. Writers: devot-mcp passes `clientInfo.name` and its session; the HTTP API writes as `http`.
  3. Storage: the `agent_writes` migration in the three adapters, with Rust checking the rows.
  4. Editor: the authorship gutter, View > Show Authorship, and the marks' accessible names.
  5. The review notice: Review Changes and Undo All.
  6. The list mark and the sidebar's Agents section.
  7. Clear Authorship.
