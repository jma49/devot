# Sync stores the latest encrypted state of each record, not an update log

Phase 2 sync is for one person with several devices. The relay holds one encrypted, current copy of every record. When two devices write the same record, the clients merge it themselves. Nothing ever appends to an update log, so nothing needs compacting. This replaces the "clients compact" line in `docs/architecture.md` (Sync and encryption). Attachments are out of scope and get their own ADR (#13, part 2).

## Records

- A record is one note, notebook or tag, under a random ID. Nothing in the ID derives from the content.
- A note record holds:
  - its body's full Yjs state (`Y.encodeStateAsUpdate`);
  - its metadata fields (title, notebook, status, pinned, tags), each with the HLC of its last change;
  - a `purged` flag.
- Notebook and tag records hold metadata fields with HLCs only.
- The client encrypts the whole record with AES-256-GCM in Rust. The ciphertext is cut into chunks of at most 1.9 MB, so each chunk fits in one Durable Object SQLite row.
  - Every chunk has its own nonce.
  - The additional data is the vault ID, record ID, record version and chunk index. A relay that swaps, replays or reorders chunks makes decryption fail.

## Relay

- One Durable Object per vault, on SQLite storage. It keeps:
  - `records(id, version, seq, chunk_count)`;
  - `chunks(id, idx, bytes)`;
  - one counters row.
- `seq` is a vault-wide counter that goes up by one on every accepted write.
- Every connection is a WebSocket on the Hibernation API.
- The relay understands three messages:
  - `pull(since_seq)`: returns the records changed after `since_seq`, in pages.
  - `push(id, base_version, chunks)`: if `base_version` equals the stored version, the relay stores the chunks, sets version + 1, assigns the next `seq` and acknowledges. If it does not, the relay rejects the write with the current version. One push is one SQLite transaction.
  - `changed(seq)`: sent to the vault's other connections after an accepted push. Outgoing messages are not billed.
- The relay never decrypts and never merges. It is not a source of truth: every device holds all records.

## Client

- **Push timing:** push a changed record after 3 s without edits, and at most once every 10 s during continuous typing.
- **Rejected push:** pull the record, merge it locally, then push again.
  - Body: apply both Yjs states to one doc. A Yjs merge never conflicts.
  - Metadata: the higher HLC wins per field.
  - Retries are capped (5, with backoff and jitter). Past the cap, the record waits for the next `changed`.
- **Local history before a merge:** before a remote state changes a local note, the client writes the current local state to `revisions` as a body revision. Any merge can then be undone from Revision History. Revisions stay local and are never synced.
- **Trash and purge:**
  - Trash is the `status` field, so the higher HLC wins.
  - An edit made after the trash (by HLC) moves the note back out of the trash, so an edit never vanishes into the trash on another device.
  - Purge pushes a tombstone: `purged: true`, no body. Tombstones are kept forever because they are tiny, so a device that comes back after months still learns about the purge. Before the tombstone removes a note, the device saves its local copy as a revision.
- **Prerequisite:** every body write must update the note's existing Yjs doc. Rebuilding the doc from text on a write breaks merging, because the same text would then appear twice after a merge. This applies to the editor, imports, the MCP server and the local HTTP API: a write that only has new text applies it as a diff to the existing doc.

## Staying inside the Workers Free plan

Assumption: the relay runs on a dedicated Cloudflare account on the Workers Free plan. The account has no paid subscription and no R2, and no payment method on file. On the Free plan an exceeded limit makes the operation fail; it is never billed.

**Daily limits (they reset at 00:00 UTC):**

| Resource                | Free limit                                                                  | This design                                                                    |
| ----------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Durable Object requests | 100k/day. Incoming WebSocket messages count 20:1; a connection counts as 1. | One push or pull is one message.                                               |
| Rows written            | 100k/day; deletes count too                                                 | About 3 + chunks per push: the record row, its chunk rows and the counters row |
| Rows read               | 5M/day                                                                      | Pulls read only the records that changed                                       |
| Duration                | 13,000 GB-s/day                                                             | Hibernation: billed only while handling a message                              |
| Storage                 | 5 GB in total                                                               | One copy per record, no history, so storage tracks the vault size              |

**Typing budget:** writing for 8 hours non-stop is at most 2,880 pushes, or about 12k rows written.

**Guards:**

- **Self-imposed cap:** the counters row tracks rows written, incoming messages and stored bytes for the current UTC day. Above 80% of any limit, the relay refuses pushes with `E_SYNC_QUOTA` until the reset. The client shows "Sync paused until <local time>" and keeps working locally.
- **Abuse:**
  - The Worker checks a per-device token (only its hash is stored) before it routes anything to the Durable Object.
  - A free Cloudflare rate-limiting rule sits on the route.
  - The relay caps message size and per-device rate.
  - A client circuit breaker stops sync when it detects an abnormal send rate.
- **Not used:** R2, KV, D1, Queues, Workers Paid, Logpush. None of them is needed. R2 in particular bills past its free tier instead of failing.

## Risks

1. **Yjs doc lineage (high).** A write path that recreates the doc from text makes every later merge duplicate the note's content. Before any sync code, audit every body write path and add a test: two devices edit, merge, and the text appears once.
2. **Concurrent offline edits to the same paragraph.** Yjs keeps both devices' insertions, which can leave the paragraph interleaved. Nothing is lost: the pre-merge revision restores either side. Revision History labels these entries as merges.
3. **Write races between two active devices.** Two devices editing the same note at once can keep rejecting each other's pushes. Bounded retries, jitter and the 10 s cap keep this short; a merge always converges.
4. **Pushing the whole state.** Every push resends the note's full state; a 1 MB note costs about 1 MB per push. The note size limit in `docs/architecture.md` bounds this. Rows written grow with the chunk count, and the self-imposed cap counts them.
5. **First upload of a large vault.** Each record costs at least 4 rows written, so the first upload fits about 20k records per day under the 80% cap. A larger vault finishes over several days, and the client shows its progress.
6. **Quota reached.** Sync pauses until 00:00 UTC; local work goes on. There is no cost and no data loss.
7. **Clock skew.** HLCs bound the skew, but a device with a far-wrong clock can win metadata fields. The client refuses to sync when its clock is more than 5 minutes off the relay's time.
8. **Relay data loss or a move to another host.** Every device holds all records, so the clients upload again. Versions restart, and the clients detect this from a new vault epoch the relay announces.
9. **Key loss.** Without the key, the relay's copy cannot be read. Devices that still hold the key are unaffected. The printed recovery key is the only way back.
10. **What the relay can see.** The relay sees how many records there are, their sizes, when they are written, and which device wrote them. It never sees titles, bodies or notebook names.
11. **Cloudflare changes the free plan.** The self-imposed cap is the line of defence. Read the limits again before each phase 2 release.
12. **Attachments are not covered.** Attachment sync gets its own ADR (#13, part 2). It needs to fit the same quota.

## Consequences

- No compaction protocol and no update log. The relay schema is two tables and a counters row, with one test suite for both the Durable Object and Node + SQLite implementations.
- `docs/architecture.md`, Sync and encryption: replace "Clients compact: …" with a link to this ADR, and add the quota cap to the cost guards.
- Phase 2 tickets: add the Yjs lineage audit as the first ticket. Replace any compaction ticket with "push / pull / CAS merge". Add the self-imposed quota cap and the pre-merge revision.
