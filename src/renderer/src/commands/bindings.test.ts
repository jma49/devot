import { afterEach, describe, expect, it } from 'vitest'
import { bookShortcut, BOOK_COMMANDS } from '../bookMenu'
import { LINE_COMMANDS, lineKeys } from '../editor/lineCommands'
import { IMAGE_COMMANDS, imageKeys } from '../imageMenu'
import { NOTE_COMMANDS, TRASH_COMMANDS, noteShortcut, trashShortcut } from '../noteMenu'
import { TAG_COMMANDS, tagShortcut } from '../tagMenu'
import { shortcutCodeMirror, type KeyPress } from './keys'
import { effectiveKeymap, keyProblem } from './keymap'
import {
  COMMANDS,
  editorFormatKeys,
  editorInsertKeys,
  editorTableKeys,
  formatOf,
  insertOf,
  setCommandKeys,
  tableOf,
  windowCommand,
  type CommandId,
  type CommandScope,
} from './registry'

// Settings > Keyboard Shortcuts offers a key for every command in the
// registry, so every one of them needs a keyboard path that runs it with the
// keys in effect: a key recorded there must do something.

/** A key every scope may take, and its press. */
const KEY = 'Mod+Ctrl+Alt+Shift+J'
const PRESS: KeyPress = {
  code: 'KeyJ',
  key: 'J',
  metaKey: true,
  ctrlKey: true,
  altKey: true,
  shiftKey: true,
}

const SOURCES = import.meta.glob<string>(
  ['../NoteList.tsx', '../areas.ts', '../NoteEditor.tsx', '../editor/find.ts', '../Sidebar.tsx'],
  { query: '?raw', import: 'default', eager: true },
)

/**
 * Commands a component matches on its own (`commandMatches`) or binds in an
 * editor keymap of its own (`commandKeys`, `editorCommandKeys`), and where.
 */
const BOUND_IN: Partial<Record<CommandId, [file: string, call: string]>> = {
  'note.editTitle': ['../NoteList.tsx', 'commandMatches'],
  'note.editBody': ['../NoteList.tsx', 'commandMatches'],
  'search.fromList': ['../NoteList.tsx', 'commandMatches'],
  'list.selectAll': ['../NoteList.tsx', 'commandMatches'],
  'list.clearSelection': ['../NoteList.tsx', 'commandMatches'],
  'list.extendUp': ['../NoteList.tsx', 'commandMatches'],
  'list.extendDown': ['../NoteList.tsx', 'commandMatches'],
  'view.nextAreaInPane': ['../areas.ts', 'commandMatches'],
  'view.previousAreaInPane': ['../areas.ts', 'commandMatches'],
  'find.nextInEditor': ['../editor/find.ts', '...commandKeys'],
  'find.previousInEditor': ['../editor/find.ts', '...commandKeys'],
  'edit.pastePlain': ['../NoteEditor.tsx', 'editorCommandKeys'],
  'note.newFromSelection': ['../NoteEditor.tsx', 'editorCommandKeys'],
  'image.view': ['../NoteEditor.tsx', 'editorCommandKeys'],
  'sidebar.rowMenu': ['../Sidebar.tsx', 'commandMatches'],
  'sidebar.workspaceUp': ['../Sidebar.tsx', 'commandMatches'],
  'sidebar.workspaceUpFromAnyRow': ['../Sidebar.tsx', 'commandMatches'],
}

/** Whether the keyboard path for the command's scope runs it on `PRESS`. */
function bound(id: CommandId): boolean {
  const known = BOUND_IN[id]
  if (known) return SOURCES[known[0]]?.includes(`${known[1]}('${id}'`) ?? false
  const key = shortcutCodeMirror(KEY)
  const format = formatOf(id)
  if (format) return editorFormatKeys().some((k) => k.format === format && k.key === key)
  const table = tableOf(id)
  if (table) return editorTableKeys().some((k) => k.command === table && k.key === key)
  const insert = insertOf(id)
  if (insert) return editorInsertKeys().some((k) => k.insert === insert && k.key === key)
  if (LINE_COMMANDS.includes(id)) return lineKeys().some((k) => k.id === id && k.key === key)
  const image = Object.entries(IMAGE_COMMANDS).find(([, c]) => c === id)?.[0]
  if (image) return imageKeys().some((k) => k.action === image && k.key === key)
  const spec = COMMANDS.find((c) => c.id === id)!
  switch (spec.scope as CommandScope) {
    case 'window':
      return (
        windowCommand(PRESS, { inEditor: false }) === id &&
        windowCommand(PRESS, { inEditor: true }) === id
      )
    case 'outsideEditor':
      return windowCommand(PRESS, { inEditor: false }) === id
    case 'noteList': {
      const action = noteShortcut(PRESS)
      return action !== undefined && NOTE_COMMANDS[action] === id
    }
    case 'trashList': {
      const action = trashShortcut(PRESS)
      return action !== undefined && TRASH_COMMANDS[action] === id
    }
    case 'notebookRow': {
      const action = bookShortcut(PRESS)
      return action !== undefined && BOOK_COMMANDS[action] === id
    }
    case 'tagRow': {
      const action = tagShortcut(PRESS)
      return action !== undefined && TAG_COMMANDS[action] === id
    }
    default:
      return false
  }
}

describe('every command a key can be set for', () => {
  afterEach(() => setCommandKeys(undefined))

  it.each(COMMANDS.map((c) => c.id))('%s runs from a key the user sets', (id) => {
    expect(keyProblem(id, KEY)).toBeUndefined()
    setCommandKeys(effectiveKeymap({ [id]: [KEY] }))
    expect(bound(id)).toBe(true)
  })
})
