import type { NoteRelayMessage } from '../../../core'

/** Whether a note window's note can be edited: in the library, in the Trash until it is put back, or deleted for good. */
export type NoteLife = 'live' | 'trashed' | 'purged'

/** The note window's only transitions: `gone` and `back` from another window; a purge is final. */
export function nextLife(
  life: NoteLife,
  message: Extract<NoteRelayMessage, { kind: 'gone' | 'back' }>,
): NoteLife {
  if (life === 'purged') return life
  if (message.kind === 'back') return 'live'
  return message.purged ? 'purged' : 'trashed'
}
