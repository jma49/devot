# A restored backup syncs only after the owner chooses: merge, or keep this device's copy

Restoring a backup puts an older library on one device. Sync merges per field by HLC and merges note bodies as Yjs documents (ADR 0002), so every change made on other devices after the backup has a newer clock and wins, and a purge is final. Left alone, the next sync undoes the restore within one cycle, with no message (#515).

## Decision

- A restore is refused while sync is on (`E_BACKUP_SYNC_ON`). The owner turns sync off, restores, and turns it on again.
- The restore sets `restoredAt` in `sync_state`. While it is set, the engine does not connect (`E_SYNC_RESTORE_CHOICE`) and the main window asks:
  - **Merge** (the default): sync as usual. The other devices' later changes come back.
  - **Keep This Mac's Copy**: every field of every live record on this device (notes, note tags, notebooks, tags, saved searches) gets a fresh HLC, so each wins its merge and is pushed. Bodies need more than a clock, since two Yjs states merge into both texts: during the first full pull after the choice, a body another device changed before the choice is edited back to this device's text on top of the merged state, and that edit is pushed, so every device ends with the restored text.
- Either way the marker is cleared. A library that never synced is not asked about.

## Consequences

- A note purged on another device stays purged: a purge wins over any edit, and the dialog says so.
- Notes, notebooks or tags made elsewhere after the backup are not in it and stay; Keep wins only over records the restored library holds.
- An edit another device makes after the choice, with a later clock, still wins as usual.
- Refusing restore outright while sync is on remains, so a restore never races a running engine.
