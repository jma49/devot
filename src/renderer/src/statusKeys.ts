// Status shortcuts: Control+Command+1 to 5 set the open note's status. Their
// keys are the registry's `status.*` commands, which work window-wide (also
// while typing in the editor), so they use a chord nothing else in Devot or
// the system menu takes; tests check that. The window runs them like its
// other commands.
import { NOTE_STATUSES, type NoteStatus } from '../../core/storage'
import type { KeyPress } from './commands/keys'
import { commandMatches, type CommandId } from './commands/registry'

/** The registry command that sets each status (its label and keys). */
export const STATUS_COMMANDS: Readonly<Record<NoteStatus, CommandId>> = {
  none: 'status.none',
  active: 'status.active',
  on_hold: 'status.onHold',
  completed: 'status.completed',
  dropped: 'status.dropped',
}

/** The status a key press asks for, if any. */
export function statusShortcut(e: KeyPress): NoteStatus | undefined {
  return NOTE_STATUSES.find((status) => commandMatches(STATUS_COMMANDS[status], e))
}
