// What a backup restore leaves for sync (#515), in the core and the page alike.

/** Set in `sync_state` by a backup restore (backups.rs): the next connect waits for a choice. */
export const RESTORED_AT = 'restoredAt'
/** The engine's status code while it waits. */
export const RESTORE_CHOICE = 'E_SYNC_RESTORE_CHOICE'
