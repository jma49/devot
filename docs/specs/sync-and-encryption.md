# Sync and encryption

Part of the [architecture overview](../architecture.md).

- **iCloud** (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md; being built): a vault can use the owner's CloudKit private database instead of a relay, with the same sealed records and the engine unchanged behind `SyncTransport`; the vault key reaches the owner's other devices through the iCloud Keychain, and the pairing code is the fallback.
  One transport per vault.
  Builds without Devot's iCloud container report `E_SYNC_CLOUDKIT_UNAVAILABLE` and keep the relay.
  - **CloudKit transport** (`src-tauri/src/sync/cloudkit/`): the transport logic (zones, paging by change token, batch caps, change tags, error mapping, asset staging) is safe Rust over a `CloudKit` trait of eight primitives (account, user record, zones exist, save zones, fetch, save, changes, subscribe).
    The objc2 implementation is written once in `native/ios/cloudkit.rs`, which macOS compiles too, so `unsafe` stays in the two native folders; tests run the transport against an in-memory fake.
    A build tells it holds the container before anything touches `CKContainer`: on macOS from its signed entitlements (`SecTaskCopyValueForEntitlement`), on iOS from `DevotCloudKitContainer` in Info.plist, empty on builds without it.
    Each operation waits at most 120 s (600 s with assets) and is cancelled after.
    A change tag is a record's archived system fields, saved under `ifServerRecordUnchanged`; a cursor is an archived `CKServerChangeToken`.
    A deleted vault zone stops sync with `E_SYNC_ICLOUD_DELETED` and nothing is made again until the owner asks (`sync_icloud_upload_again`).
    A connect that makes the vault zone again keeps that step (`remade`) before it makes the zone, so until one such connect finishes, each one renews the epoch and subscribes again.
    Silent pushes (a zone subscription) and `CKAccountChanged` reach the engine as `changed` and `account` events; since a silent push may not come, the engine also fetches a vault on iCloud every 5 minutes, when a window comes to the front and after each push.
    No iCloud account (`E_SYNC_ICLOUD_SIGNED_OUT`), a restricted one and a full iCloud pause with no end; an account change connects again.
    Commands for Settings (#606): `sync_icloud_status`, `sync_icloud_use` (a new vault, or one restored from its recovery key), `sync_icloud_upload_again`; batches go through `sync_push_many`, which the relay refuses (`E_SYNC_BATCH_UNSUPPORTED`).
- **Protocol first:** a versioned message format over WebSocket, with no dependency on any one host.
- **Relay** (`relay/`, docs/sync-relay.md): plain TypeScript logic over a storage interface (the host's SQLite) with two implementations: a Cloudflare Worker in front of one Durable Object per vault on SQLite storage, and Node + SQLite (a file per vault) for a server.
  One test suite runs against both, the Durable Object locally in workerd through Miniflare.
  The relay URL is a client setting.
  The app never imports the relay; the relay takes from the app only the wire format (`src/core/sync/protocol.ts`).
- **Protocol (version 1):** JSON envelopes `{v, type}`; a message with chunks travels as one binary frame (header length, JSON header, raw chunks).
  `pull(since)` in pages, `push(id, base, kind, chunks)` as one SQLite transaction with compare-and-swap on the version, `changed(seq)` to the vault's other connections; `welcome` on connecting gives the relay's time and the vault epoch.
  Devices enroll by presenting an enrollment secret derived from the vault key (the relay stores only its verifier) and get a device token, of which the relay keeps only the hash; the front checks the token's MAC (keyed from the relay's own secret) before anything reaches the vault.
  Device list and revoke go over the socket.
  Pairing has HTTP routes of its own under `/v1/pairings/` (docs/sync-relay.md); a relay from before them answers `E_SYNC_NOT_FOUND`, which the client reports as `E_SYNC_RELAY_OUTDATED`.
- The relay is not a source of truth.
  Every device holds the full data, so moving to another relay means pointing clients at a new URL; they re-upload.
- The relay only sees ciphertext.
  It stores the latest encrypted state of each record, and clients merge on a rejected push (docs/adr/0002-sync-latest-state-per-record.md).
- **First deployment:** a dedicated Cloudflare account on the Workers Free plan.
  When a free limit is exceeded, requests fail instead of being billed; the worst case is that sync pauses until the daily reset, while local data is unaffected.
- **Cost guards (required on any host):** the WebSocket Hibernation API only; client reconnects with exponential backoff, jitter and a rate cap; a changed record pushed after 3 s without edits, and at most every 10 s while typing; server-side per-device rate and message-size limits; a client circuit breaker that stops sync when it detects abnormal send rates; a self-imposed cap at 80% of every free limit the relay can count (on by default on Node too, `RELAY_QUOTA=off` turns it off there; docs/sync-relay.md, Quota).
- **Attachments** (docs/adr/0003-sync-attachments-as-records.md, #327): one encrypted record of kind `file` per attachment on the same relay, downloaded by every device, within a 3 GB share of the relay's storage.
  - **Record** (`src/core/sync/records.ts`, `FileState`): `format byte || header length || JSON fields || image bytes`; the fields are the ID, name, MIME type, size, `noteId` with `noteHlc` (the clock of its last change; '' for a file never passed on), `createdAt` and `purged`.
    A purged file is a tombstone with only its ID and `purged`, kept forever.
    Migration 0022 adds `files.note_hlc`, lets `sync_records` hold `file` and puts triggers on `files`, so an attachment is pending like a note; a purged one has no row, only its entry, which the engine reads as the tombstone.
  - **Merge:** the bytes are written once, so only the owner merges: the higher `noteHlc` wins (equal clocks: the greater note ID); a purge wins over everything.
    `HAND_OVER_FILES_SQL` dates the new owner with the purge's HLC, so every device settles on the same note.
  - **Upload order:** before the first push of a note, the engine pushes the attachments its body links (up to 500, not yet synced).
    The bytes cross to Rust as base64 only when the record is pushed (`sync_file_data`).
  - **Checked on both sides:** `src-tauri/src/sync/file_record.rs` checks a file record as a paste is checked (`validate_upload`: a known raster image of at most 10 MiB, SVG refused, the type and size the header names) on the way out before it is sealed, and on the way in before the web view sees it; the core checks again (`decodeRecord`), and `sync_file_put` once more before the row is written.
    A record that fails is logged by code and ID (`W_SYNC_FILE_REFUSED`, `W_SYNC_RECORD_SKIPPED`) and left out.
    An existing row never takes new bytes.
  - **The share:** the relay refuses a push past 3 GB of file records with `E_SYNC_ATTACHMENTS_FULL` (`PushResult` `full`).
    The attachment stays local and is counted as unsynced; notes keep syncing.
    The engine does not offer a larger image once a smaller one was refused, tries again after a purge (pushed or pulled) frees room, and on the next launch.
    A relay that does not say `attachments` in its `welcome` is sent no image (`E_SYNC_RELAY_OUTDATED`; docs/sync-relay.md, Update the relay).
    Settings > Sync shows how many images are not synced and why (`unsyncedFiles` in the status Rust keeps).
  - **A link whose image has not arrived** shows a placeholder at `size.inline-image-height` in the editor and the preview (`src/renderer/src/missingImages.ts`): an `<img>` that fails to load from `devot://file/<id>` is marked `image-missing` (an empty alt and a transparent pixel as its content keep the web view's broken-image icon away), and loaded again whenever the database changes, which is how a pulled image arrives; a patch of the preview that keeps the image's address keeps its placeholder (`preview/dom.ts`), since no second error comes.
    In the preview and Write mode's blocks any image that fails is marked the same way (its label says it could not be loaded) but not loaded again.
    An image alone in its paragraph shows the block placeholder there instead: the block's box (`color.fill.card`, `radius.list-row`) three body lines high, Devot's broken-image glyph centred in `color.text.tertiary` and the alt text under it at caption size (`content.css`, the alt from the paragraph's `data-image-missing-alt`).
- **Encryption:** AES-256-GCM, done in Rust.
  Keys come from device pairing: the first device generates the key, new devices pair by a one-time code (QR code or text), and keys live in each device's keychain.
  A recovery key is shown for printing or safe storage until the owner says it was saved.
- **Vault** (`src-tauri/src/sync/`): a random vault ID (a UUIDv4) and a 256-bit vault key from the OS random source, made on the first device that turns sync on.
  Both live in one keychain item (a generic password, service `<folder identifier>.sync`, so a debug build's `.dev` never reads the installed app's vault; never synced through iCloud; on iOS readable after the first unlock and kept off backups), never in files, settings or logs.
  Making or restoring a vault adds the item only when the keychain holds none (`SecItemAdd`, which refuses a duplicate in one step, so two windows or processes at once cannot both add), so a key that may be the only copy is never replaced.
  No command returns the key or a secret derived from it, and only `sync_recovery_key` returns the recovery key, until this device says it was saved: the core hands plaintext records to Rust and gets plaintext back, and Debug output and errors show the vault ID at most.
- **Records:** each record is sealed under a record key derived from the vault key (HKDF-SHA256, salt the vault ID, its own label) and cut into chunks of at most 1.9 MB (1,900,000 bytes, nonce and tag included), each `format byte || 96-bit random nonce || ciphertext || tag`.
  The additional data is a label, the vault ID, the record's store name, the record version, the chunk's index and the chunk count, so a swapped, replayed, reordered, truncated or extended chunk set fails to open (`E_SYNC_CHUNK_AUTH`).
  A record holds at most 80 MiB of plaintext (a note's Yjs state may take 64 MiB); record IDs and store names are 1 to 64 ASCII letters, digits, hyphens and underscores.
- **Store names** (`src-tauri/src/sync/names.rs`, docs/adr/0016-store-names-hide-record-ids.md): a relay and iCloud file each record under `r` and the base64url of HMAC-SHA256 of its ID, keyed from the vault key (HKDF-SHA256, its own label), never under the ID, whose UUIDv7 time would show when the record was made.
  The payload sealed is `ID length || record ID || record`, so a pulled record opens to its ID, which must give back its name (`E_SYNC_RECORD_ID`).
  The moved marker keeps its reserved ID as its name.
  The engine sees the store's epoch marked (`<epoch>+names`), so a device on its first connect after the update to store names uploads everything again under them; records still filed under their IDs are left on the store and not handed on.
  Rejecting an older version the relay replays under its old number is the client's job (it remembers the versions it has seen).
- **Enrollment:** any holder of the vault key derives the enrollment secret (HKDF-SHA256, its own label) and presents it to the relay, which keeps only its verifier, SHA-256 over a label and the secret (`enrollmentVerifier`, the same in Rust).
- **Client engine** (`src/core/sync/engine.ts`, in the main window's core worker, the iPhone app's one window included (`useSyncEngine`); docs/adr/0002-sync-latest-state-per-record.md, Client): the core builds and merges records, Rust seals them and holds the socket.
  A record is a note (with its tag memberships), a notebook or a tag under its own ID (`src/core/sync/records.ts`): `format byte || header length || JSON fields || Yjs state`.
  Allow AI Access is not in it (each device decides what AI tools may read), nor are revisions; an attachment travels as its own `file` record (#327).
  - **What changed:** every write of a note row, its tag rows, a notebook or a tag moves its `sync_records.edits` on (triggers in `migrations/0019_sync.sql`, so every writer counts); the engine looks at a record while `edits` differs from `synced` and pushes it only when its fingerprint (the fields, and the body's state vector and delete set, so equal content gives an equal print whatever the bytes) differs from the one the relay's version stands for here (`fingerprint`).
    The engine's own writes of another device's state set that print, so they are never pushed back.
  - **Push timing:** after 3 s without writes, at most 10 s after the first of a run of writes (`PUSH_IDLE_MS`, `PUSH_EVERY_MS`).
    Every push reads and sends a note's whole record, so a large note waits longer: after the engine read it, the next push of a note whose state is more than 1 MB waits one second for every 100 KB, at most a minute (`pushPaceMs`; 2 MB about every 20 s), and a pass that finds it waiting runs again when the wait ends.
    Past about 6 MB the minute's cap is reached, so what such a note sends a minute grows with it again.
    While offline its stamps are read at the same pace.
    Every change to such a note waits the same way (a rename, a trash, a move, a tag or a pin), and a flush, Sync Now or a quit sends it at once.
    The body stamp is taken by the pass that sees the note's latest write, as before, so it is never earlier than the body's last change and an edit made after a trash on another device still brings the note back.
    A trash made on another device after that pass wins as it did before.
    A pass during the wait sees only that the note changed, not what: when a rename or another write follows a body edit during the wait, the stamp moves on to the pass that sees it, so a trash made on another device between the two is overturned and the note comes back with both (nothing is lost).
    A pass that leaves a note waiting keeps the last sync time as it was, since not everything here is synced.
    When the app goes out of sight or quits, whatever waits for a push timer or a pace goes at once (`flush`; a quit that skips the quit handshake leaves it for the next launch); a large backlog (`pushMany`) and the push again after a rejected one never wait.
    The wait's own pass does not fetch from iCloud.
    A push is based on the version this device last saw; the relay's compare-and-swap rejects it when another device wrote first, and the engine pulls (which merges), then pushes again, at most 5 times with backoff and jitter; past that the record waits for the next `changed`, and on iCloud, where a silent push may not come, for the next poll or focus pass.
    One record pushed more than 30 times in a minute is a loop, not typing: sync stops with `E_SYNC_CIRCUIT_OPEN`.
    The engine keeps each record's push times only while they are inside that minute; every push pass ends by dropping the rest.
  - **Pull and merge:** pulls page from the cursor in `sync_state` (`since`, an opaque string; see Transport seam); a version not above the one already seen is a replay and is skipped.
    Body: both Yjs states in one document.
    Metadata: per field the higher HLC (dates as storage merges them, tag memberships each by their own HLC); notebooks and tags the same, sort keys at equal HLCs the greater key.
    The merged note is written through `putNote`'s compare-and-swap, so a local save meanwhile is merged in, not lost, and the note service then takes it in as it does another process's writes.
    A note open in a note window gets it through the main window's core (`mergeStored`): a note that core holds relays what it took in, title included, as its own changes; one it does not hold, but another window spoke of, is relayed its stored state, once for each write.
    A record that does not open or read is logged by code and ID and skipped; a storage failure stops the pull, to retry.
  - **Trash and purge:** the Trash is the note's `deletedHlc` field, the higher HLC winning.
    Each record also carries `bodyHlc`, stamped when the engine finds the body changed here (not while the note is in the Trash); a body or title change after the move to the Trash brings the note back on every device, the same way (`deletedHlc` becomes that edit's HLC).
    A purge is a tombstone (ID, `purged`, deletion; no body) that wins over everything, and is kept forever.
  - **Clock and epoch:** the engine refuses to sync while this device's clock is more than 5 minutes off the relay's (the `welcome` time; `E_SYNC_CLOCK_SKEW`, checked again every 5 minutes).
    A `welcome` with another vault epoch than the one stored (a relay that lost its data, or a new relay) resets every record to version 0 and uploads everything again.
  - **Transport seam** (`src/core/sync/transport.ts`, docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md): the engine knows a transport only through `SyncTransport`.
    A cursor is an opaque string, `''` the start; the relay's `seq` crosses as its decimal text (`client.rs`, `cursor_of` and `seq_of`), so a numeric `since` stored by an older build reads on, and `'0'` is the start.
    Whether a library ever synced is its own key, `hasSynced`, set after a pull past the start or a first push; migrations 0026 and 0027 set it for a library whose stored `since` is past the start or that holds a pushed record.
    A stored cursor the transport no longer reads (`E_SYNC_CURSOR_INVALID`) is dropped once for the start.
    Each record keeps an opaque change tag beside its version (`sync_records.tag`, migration 0026; always `''` on the relay, checked and dropped by `sync_push`): a push names it and a `rejected` returns the server's, used once the merge has reached that version.
    A backlog (an upload of at least `uploadShownFrom` records) goes out through `pushMany` in batches of at most 100 records and 8 MiB, each result handled as a single push's; the relay transport runs a batch one push at a time, so the wire is as before, and other pushes keep the 3 s / 10 s timing one by one.
    Pending records page by `sync_records.upload_key` (migration 0028), 16 random hex digits followed by the record ID, not by the ID, so a backlog does not go out in the creation order UUIDv7 IDs sort in (#639).
    The key is unique, so it is the paging cursor itself: an interrupted upload starts again from the first pending key, and every record pushed before the interruption is no longer pending, so none is sent twice or skipped.
    A new epoch (`syncReset`) draws every key again, so two backlog uploads do not go out in the same order.
    A pause carries a code: none, or `E_SYNC_QUOTA`, is the relay's quota cap below; any other is waited out to its `until`, and one without an end (`E_SYNC_ICLOUD_FULL`) is looked at again hourly, when a window comes to the front (`focused`) and on launch, with the records that still fit kept going.
  - **Moved marker** (`src/core/sync/moved.ts`): a vault that leaves a transport leaves on it an ordinary sealed record of kind `record` under the reserved ID `00000000-0000-7000-8000-000000000000` naming the transport it went to.
    The engine reads it before decoding, never stores it, and never pushes a local record with that ID (`W_SYNC_RESERVED_ID`); a marker naming another transport stops the device (`E_SYNC_VAULT_MOVED`, logged `W_SYNC_VAULT_MOVED` with both names).
    Builds from before it fail to decode its body (`E_SYNC_RECORD_INVALID`) and skip it like any record a newer build may read; a test holds today's decoder to that.
  - **Stops and notices:** `E_SYNC_REVOKED`, an unknown device, a missing vault key or token stop sync until the user acts; the window says so in a notice, and a revoked device keeps its credentials marked so it never enrolls again on its own.
    A relay without the vault (`E_SYNC_NO_VAULT`, for example after it lost its data) makes the device drop its token, so Settings > Sync asks for the relay secret again to create the vault there under a new epoch.
    A record past the relay's limits (16 chunks, found before anything is sent: `E_SYNC_TOO_LARGE`) stays on this device; the notice and Settings say how many.
    Network failures retry with exponential backoff and jitter (1 s to 5 minutes), and at once when a window comes to the front (`focused`; on the iPhone, the app coming back from the background, `visibilitychange`), unless the failure named its own wait (CloudKit's `E_SYNC_ICLOUD_BUSY`, the relay's `E_SYNC_RATE`); the relay's `E_SYNC_RATE` is otherwise waited out in Rust.
    A device still connected runs a pass when a window comes to the front: the socket's ping and 120 s silence check count uptime, which stops while the machine sleeps, so a socket that died in the sleep is found by that pull: at once when the network resets it, else when its request times out (120 s or more).
  - **Quota cap** (docs/sync-relay.md, Quota): the relay refuses pushes past 80% of a Workers Free limit it counts (rows written and requests a day, stored bytes in total) with `E_SYNC_QUOTA` and `until`, its next 00:00 UTC; pulls stay allowed.
    The engine closes the socket, reports `paused` with that time (the notice and Settings > Sync say "Sync paused until" it, in local time), and connects again once, at a random moment in the minute after it (measured on the relay's clock from the `welcome`, checked at least hourly, since a timer falls behind while the machine sleeps); a refusal without `until` (a relay that did not say) waits for the next 00:00 UTC.
    A refusal for `storedBytes` lasts past the reset, so the pass goes on with the records that fit (smaller ones, purges) and pauses after it.
    A pass the socket closed in the middle of stops there, so the upload keeps its place.
    A pass that finishes after a stop or a drop was reported ends with that status, not idle, and leaves the last sync as it was.
    Local work goes on.
    A backlog of at least 100 records (a first upload, a new epoch) reports its progress, records sent of the total; the total is kept in `sync_state` (`uploadTotal`) and what is left is the pending count, so a restart keeps its place and a large vault uploads over several days.
    A `welcome` without `quota` comes from a relay older than the cap: sync goes on, and Settings > Sync says to update the relay.
- **Storage readings** (`src/core/sync/usage.ts`, `src/renderer/src/syncUsage.ts`; docs/sync-relay.md, Storage in the app): Rust asks the relay for `usage` on the live socket, or on one it opens for the call (`sync_usage`, read-only, not gated by the license), and the web view turns the answer into notes and other records, images, total and room left against the caps the relay itself reports, so nothing in the app assumes a host's limits.
  `caps` null (`RELAY_QUOTA=off`) and absent `caps` (a relay from before the cap) are shown as such, and `E_SYNC_BAD_MESSAGE` (a relay from before `usage`) as a relay to update.
  After sync settles the main window reads it at most every 15 minutes and sets one notice when a cap's band (below 80%, 80% to the cap, at the cap) goes up from the one last told, kept per relay in the window's storage; no cap and no answer say nothing.
  No protocol change was needed: `usage` already carried `caps`.
- **Transport** (`src-tauri/src/sync/client.rs`, `service.rs`): vault creation and enrollment over HTTP (ureq: no redirects, no proxy), the socket over tungstenite on a thread of its own, both over the system TLS stack; https only, or http to this machine.
  The device token lives in the keychain beside the vault (account `device`, with the relay's URL and the vault ID it belongs to), never in a file or the web view.
  A token the relay's front refuses (its secret changed) makes a device that holds the vault key enroll again; a device the vault does not know (revoked) does not.
  A device with the vault key and no token for the relay enrolls on its own; joining (below) enrolls at once.
- **Settings > Sync:** a device that holds no vault first asks one question, whether this is the first device or another one being added (nothing in Welcome or the first launch asks about sync), and then shows only that path.
  The first-device path takes the relay's URL and its secret (once, sent in that one request and never stored) and makes the vault; the other path takes Join With a Code and Join With Recovery Key, with the relay's address below them, and offers no way to make a vault.
  A device that holds a vault the relay does not know (the relay lost it, or this device was removed) skips the question and asks for the secret again to reconnect to the same vault.
  In a vault, Settings shows the relay's URL, then the recovery key (offered from the first time the vault is ready on a relay until I Saved It, across pane switches and closed windows; Copy puts it on this Mac's clipboard only, marked concealed and transient, and clears it after 90 seconds, or when Devot quits first, unless something else was copied: `clipboard_write_secret`), Add a Device (a pairing code with its QR code, countdown, Copy Link and Cancel; the link, `devot://pair?relay=…&code=…`, names the relay, which the bare code cannot without a format change, and is copied as a secret like the recovery key) and Devices (this one marked; Remove asks first, then revokes the other's token) on one that is, sync on or off, and the status the engine reports through Rust (state, last sync, code, records kept here, when a quota pause ends, an upload's progress, a relay to update), then the relay's storage (below).
  Settings live in `<app data>/sync-settings.json`, with the vault whose recovery key was saved (`recoveryShown`, a vault ID).
  Pairing and joining need the license (`E_LICENCE_REQUIRED`); listing and removing devices do not.
- **Pairing** (docs/adr/0008-sync-device-pairing.md, `src-tauri/src/sync/pairing.rs`): a device that syncs makes a 128-bit pairing secret and shows it as a pairing code (32 Crockford base32 characters with a version and a checksum, in groups of four) and as a QR code of `devot://pair?relay=…&code=…`.
  Both devices derive from the secret, with HKDF-SHA256, the pairing ID the relay files it under and a key the relay never sees.
  The showing device seals the offer (the vault ID and key and its expiry) under that key and leaves it on the relay for 10 minutes; the joining device takes it once, opens it, enrolls on its own, and only then keeps the token, the vault (never replacing another one: `E_SYNC_VAULT_EXISTS`, checked before the offer is taken) and sync on, and returns its device ID sealed under the same key, which the showing device opens before it reports the pairing.
  The showing device polls every 2 seconds, through an unreachable relay too, and closes the pairing then, on Cancel, when the Settings window is destroyed (`sync::on_window_event`), when polling fails otherwise, and at the expiry, or, when the offer was taken, after the relay's minute of grace; a taken offer never confirmed ends as `unconfirmed`, which Settings warns about.
  An offer or confirmation that does not open (`E_SYNC_PAIRING_AUTH`) leaves nothing behind; an offer past its sealed expiry by more than 5 minutes is refused (`E_SYNC_PAIRING_EXPIRED`).
  The new device never learns another device's token.
  Rust joins only through the relay set in Settings: a link for another relay is refused (`E_SYNC_PAIRING_RELAY`), and Settings asks, naming the host, before it sets the relay a link names.
  A removed device keeps a revoked mark per vault and never enrolls again on its own, under any relay address; it still holds the vault key, so it can join again on purpose until the owner changes the vault key (docs/adr/0017-sync-key-rotation.md): Change Vault Key makes a new vault on the relay and retires the old one for it, both with the relay's secret (the relay then refuses its pushes, pulls and enrollments with `E_SYNC_VAULT_ROTATED`) and switches, and the other devices join the successor with a pairing code or the new recovery key.
  A connect waits until a key change under way has finished or failed, so it never drops or switches a rotation that change is still making.
  The rotating device keeps its token for the retired vault (`device-retired`, recorded for the successor, with the tokens of earlier changes it made in the same chain), and its devices list adds those vaults' other devices, marked not joined; a device that joins the successor in place of the retired vault removes itself from the retired vault with its old token and forgets tokens it kept for another successor, Remove takes one off the list (the lost device), and a token goes once none is left in its vault.
  The relay wipes a retired vault's records on its own, within a quarter of the daily rows cap, and keeps its devices and retirement; it drops a vault with no record, one device and no retirement either way that nobody connected to for 90 days, such as a successor left by a lost race (docs/adr/0017-sync-key-rotation.md, Clearing the relay).
  A rotation whose waiting successor was dropped makes it again with the waiting key.
  On iCloud (ADR 0017, On iCloud; `sync_icloud_rotate`), Change Vault Key asks no secret: it makes zone `devot-<new ID>` and its epoch, saves `successor-<old>-<new>` in zone `devot` (the new ID sealed under the old key, and a MAC over both IDs under the new key), moves `current` under `.ifServerRecordUnchanged`, writes the handover item, switches and deletes the old zone, epoch and device rows.
  Every step is kept before the next, so a connect carries on a rotation that stopped; of two at once, the one that moved `current` wins and the other deletes what it made and follows.
  Another device on the Apple ID follows at its next connect when the successor record opens under its key and the handover item holds the vault `current` names with a MAC that holds; otherwise it stops with `E_SYNC_VAULT_ROTATED` and joins with a pairing code or the new recovery key, which may replace the held vault for that successor only.
  Leave This Vault on a relay vault (docs/adr/0008-sync-device-pairing.md, Leaving a relay vault; `sync_vault_leave`) turns sync off and forgets, on this device only, the vault key, the tokens (`device-retired` too), a rotation's `-next` items and the `rotating` and `rotated` records; the notes and the relay's address stay, nothing changes on the relay, and the device can then join any vault as one with no vault.
  Each leave is counted in the sync settings (`leaves`) and marks the epoch the engine sees, so the join after it uploads the whole library, even into the vault left.
  A leave takes the lock a connect holds throughout and then the one a move to iCloud holds, so a connect or move under way ends before the leave starts and keeps nothing of the vault left.
  The page sees the code and the QR code's modules (drawn in `color.qr.*`) while the code is on show, and the outcome; Rust keeps the secret and the key.
  The offer and confirmation go through a `PairingChannel` (open, take, confirm, poll, close); `RelayPairing` is the relay's, and a vault in iCloud gets its own (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md).
- **Recovery key:** the vault ID and key with a version byte and a 4-byte checksum (SHA-256 over a label and the rest), as 85 characters of Crockford base32 in groups of five.
  Reading it ignores case, spaces and hyphens and takes O for zero and I or L for one; a mistyped key fails its checksum (`E_SYNC_RECOVERY_CHECKSUM`) before anything uses it.
  Entered with the relay's URL on a new device, it restores the vault into the keychain (or finds it there already), enrolls the device and turns sync on; it needs nothing a relay from before pairing lacks.
