# Plugin drawings sync with the note; the iPhone runs no plugin

Status: accepted (2026-11-18). Builds on plugin drawings (ADR 0027) and editable blocks (ADR 0029), for the iPhone (ADR 0018) and every window that runs no plugin.

Plugins run only in the Mac's main window and never sync (ADR 0005), so on the iPhone a block a plugin draws shows as code.
The iPhone will not run plugin code: instead, the Mac keeps each drawing a plugin makes, the drawings sync with their note, and a device without the plugin shows the kept drawing while the block is unchanged.

## Why

- Running plugins on the iPhone would mean a second sandbox, a way to install and sync plugin packages, and review rules for code the App Store did not see; a drawing is data, and the page already rebuilds a plugin's SVG through an allowlist (ADR 0027).
- A drawing depends only on its plugin, its block and the appearance, so a copy drawn on the Mac is right on every device until the block changes.

## Rules

- A kept drawing is keyed by the plugin's ID, the fence language, the SHA-256 of the block's content as the preview reads it (the code block's text, without its last line feed) and the appearance (`light` or `dark`, kept apart).
- The main window keeps a drawing when its plugin answers one that the page could rebuild; it keeps the rebuilt SVG serialized, with its stylesheet in one `style` element, never the plugin's answer as it came.
- A drawing over 256 KiB (`MAX_DRAWING_BYTES`, its UTF-8 bytes) is not kept, and a note keeps at most 32 drawings and 1 MiB of them (`MAX_NOTE_DRAWINGS`, `MAX_NOTE_DRAWINGS_BYTES`); a drawing that would pass either is not kept, and the ones kept before stay.
- Only a device whose plugin draws drops that plugin's drawings: when it keeps a drawing and when it pushes a change made to the note there, it drops the plugin's drawings of blocks the note no longer holds, under a new clock.
  A device without the plugin (the iPhone, a Mac without it or with it off) never drops one, so a block edited there keeps the stale drawing, and with it the note that the drawing updates on a Mac, until a device with the plugin draws the block again or pushes a change to the note.
  A device with the plugin that only pulls the edit drops nothing, even when the pull makes it push (for drawings the pulled note lacked, such as one a Devot from before this ADR left out).
  The engine knows a push only hands back a pull while the note's `edits` have not moved since that pull, which it keeps in memory; after a restart such a push drops as for a change.
- Uninstalling or turning off the plugin drops nothing: its drawings stay until a device with the plugin drops them.
- **Where they live:** in the note's own sync record, as two header fields beside its others, `drawings` (the list) and `drawingsHlc` (when it last changed).
- **Merging:** two devices' lists merge by key, since a drawing depends only on its key.
  A drawing of a block the merged body holds is kept from either side, so two devices drawing different blocks at once both keep theirs.
  A drawing of a block the merged body no longer holds is kept only from the side with the higher clock, so a drop reaches the other devices and is not brought back by them.
  Past the caps, the drawings of blocks gone are dropped first, then within each group the higher keys, so the held blocks' drawings are kept first and every device keeps the same ones.
  The merged clock is the higher one, and a merged list that differs from the stored one under that same clock is written under a new clock and pushed.
  A pull merges into the list as it is stored when the pull writes it, in the same turn as a drawing kept meanwhile, so neither loses the other.
- A drawing a build cannot read, or a field it does not know, is left out of the list it reads rather than the whole list, so a later build can add fields to a drawing.
  A write from the page (`note_drawings_put`) is strict: one with a field the build does not know is refused, never stored without it.
  Locally they are a row of their own, `note_drawings` (migration 0031), whose writes mark the note pending like a write of its tags.
  A separate record kind was weighed and refused: the note record is sealed in Rust on every path a note takes (the relay, iCloud, an upload after a new epoch or a move, a restored backup), so the drawings are encrypted wherever the note is, and no transport, quota rule or skip count has to learn a new kind.
  It also keeps a drawing in the same push as the block it was drawn from, so another device never holds one without the other for long.
- A note without drawings encodes and prints (`fingerprint`) exactly as before, so the update pushes nothing again.
- **Showing one:** a window without a plugin for the block's language (the iPhone, a note window, a Mac without the plugin or with it off) shows the kept drawing for the block's language, hash and appearance in the preview.
  The page reads the synced SVG as untrusted: it rebuilds it through the same allowlist as a live plugin drawing (`importPluginSvg`) into a shadow root of its own, and never inserts the synced markup itself.
  The rebuild bounds the size of each SVG filter primitive that costs with it and leaves out CSS `filter` and `backdrop-filter`, whose functions take any size.
  A kept drawing has no Edit button.
  A block whose content no longer matches shows as code with a short note that the drawing updates on a Mac where its plugin is installed.
- A window whose plugin draws the language asks the plugin as before and makes no kept-drawing island for it; a block the plugin declines stays code.
- Exported and printed pages show plugin blocks as code, as before.

## Consequences

- A kept drawing carries the colours of the theme it was drawn under on the Mac; another theme of the same appearance shows them as they are.
- An appearance the Mac never drew a block in shows the block as code with the note, until the Mac shows it in that appearance.
- A Devot from before this ADR reads a note record and ignores the two fields, so an edit it pushes leaves the note on the store without drawings.
  The next newer device to merge that note holds the higher clock and pushes its drawings back; until then, devices show the block as code.
  All devices are the owner's, so this quirk is documented rather than guarded.
- A drawing that depends on more than its block, such as a query a plugin draws from other notes (ADR 0028), is as fresh as the last time the Mac showed it.
- The note record grows by its drawings, within the 80 MiB a record may hold beside its 64 MiB of Yjs state.
- Each push of a note carries its whole drawing list, up to 1 MiB, even when only its text changed.
- A build that reads a drawing without a field a later build added pushes it back without that field.
