# Attachments sync as records on the same relay, within a fixed share of its storage

Attachments sync through the relay of ADR 0002, as records of their own: one encrypted record per attachment, in the same Durable Object SQLite storage as notes. Every device downloads every attachment. Attachments may use at most 3 GB of the relay's storage. Past that, new attachments stay on the device that added them and notes keep syncing. This closes #13, part 2.

## What an attachment is today

- An image (PNG, JPEG, GIF, WebP or AVIF, detected from its bytes), at most 10 MiB, stored as a row of `files` with its bytes.
- It belongs to one note (`files.note_id`), which shows it as `devot://file/<id>`.
- Its bytes never change. It is created, copied under a new ID (Duplicate, New Note from Selection, templates), passed to another note when its note is purged, or deleted.

Because the bytes never change, two devices can never write different bytes for one attachment, so there is nothing to merge but its owner.

## Records

- A file record holds:
  - the attachment's ID, name, MIME type, size and bytes, written once;
  - `note_id`, with the HLC of its last change;
  - a `purged` flag.
- It is encrypted and cut into chunks like any record (ADR 0002): at most 1.9 MB a chunk, so a 10 MiB image is 6 chunks.
- A rejected push merges as metadata does: the higher HLC wins `note_id`. The bytes are the same on both sides.
- Purging an attachment pushes a tombstone (`purged: true`, no bytes), kept forever. The relay deletes the record's chunks, so the space comes back.
- A copy is a new attachment with its own record. The relay never learns that two records hold the same bytes; copies cost storage like any other attachment.

## Client

- **Upload order:** a device pushes an attachment before the first push of a note that shows it, so another device rarely sees the link before the image.
- **Download:** every device pulls every file record, like notes. Every device then holds all the data, so a relay can still be replaced by uploading again (ADR 0002, risk 8).
- **Checked again on arrival:** Rust detects the image format from the decrypted bytes and refuses anything `files` would refuse from a paste. A record that fails is logged by code and ID and left out.
- **A link whose image has not arrived** shows a placeholder at the fixed inline image height (`size.inline-image-height`), so nothing moves when the image arrives.

## Storage share

The relay's storage is 5 GB on the Free plan, and the self-imposed cap (ADR 0002) stops writes at 80% of it, about 4 GB.

- Attachments may use 3 GB of it, so notes, notebooks and tags always keep about 1 GB.
- The counters row tracks the bytes stored by file records.
- A push that would take file records past 3 GB is refused with `E_SYNC_ATTACHMENTS_FULL`. The client keeps the attachment local, marks it unsynced and pushes it again after a purge frees space or on the next launch.
- Notes, notebooks and tags keep syncing. Settings shows how many images are not synced and why.
- Rows written stay small: a 10 MiB image costs about 9 rows (record, 6 chunks, counters). The first upload of a vault's attachments is bounded by storage, not by rows.

## Risks

1. **The 3 GB share is too small.** A vault with many photos fills it. Nothing is lost: images stay on the device that added them, and Settings says so. A larger share needs another store (a paid plan or a second relay), which gets its own ADR.
2. **Images on a phone.** Every device downloads every image, which costs an iPhone storage and data. A Wi-Fi-only switch can come with the iOS work; downloading on demand would break "every device holds all the data" and is not planned.
3. **Larger files.** The design assumes images of at most 10 MiB. Other kinds of attachments, or larger ones, need a new ADR.
4. **A link whose attachment never arrives.** The adding device may be offline for good before it uploads. The placeholder stays; the link still resolves if that device comes back.
5. **Two devices pass an attachment to different notes** (each purged the owner while offline). The higher HLC wins, and both candidate notes still show the image, so no note loses it.

## Consequences

- Phase 2 ticket: "Sync: attachments" (#327), after push / pull / CAS merge (#214).
- The relay counts the bytes of file records apart from the rest.
- ADR 0002, risk 12, points here.
