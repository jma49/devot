// The find shortcuts. Their keys are the registry's `find.*` commands; they
// work window-wide while a note is open, ahead of the editor's own keys (see
// `useFind`).
import type { KeyPress } from '../commands/keys'
import { commandMatches, type CommandId } from '../commands/registry'

export type FindAction = 'find' | 'replace' | 'next' | 'previous' | 'regexp' | 'caseSensitive'

export const FIND_COMMANDS: Readonly<Record<FindAction, CommandId>> = {
  find: 'find.find',
  replace: 'find.replace',
  next: 'find.next',
  previous: 'find.previous',
  regexp: 'find.regexp',
  caseSensitive: 'find.caseSensitive',
}

const ACTIONS = Object.keys(FIND_COMMANDS) as FindAction[]

/**
 * The find action a key press asks for, if any. Keys are matched by their
 * physical position (`code`), since Option changes the character typed.
 * Unlike other commands, a held key repeats (Cmd+G steps on).
 */
export function findShortcut(e: KeyPress): FindAction | undefined {
  // Fields one by one: a KeyboardEvent's are getters, which spreading drops.
  const press: KeyPress = {
    code: e.code,
    key: e.key,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
  }
  return ACTIONS.find((action) => commandMatches(FIND_COMMANDS[action], press))
}
