// What the command palette can list: the window's commands, and its
// notebooks, tags and notes.
import type { NoteSummary } from '../../../core'
import type { BookNode } from '../../../core/books'
import { shortcutLabel } from '../commands/keys'
import { COMMANDS, commandKeys, type CommandHandlers } from '../commands/registry'
import { displayTitle } from '../headlines'
import type { MessageKey } from '../i18n'
import type { PaletteEntry } from './results'

/**
 * The commands the window has a handler for, in registry order, labelled
 * through `label` (the catalog), with their first key in effect. Commands marked
 * `palette: false` (opening the palette, notebook row keys) are left out.
 */
export function commandEntries(
  handlers: CommandHandlers,
  label: (key: MessageKey) => string,
): PaletteEntry[] {
  return COMMANDS.flatMap((c): PaletteEntry[] => {
    const handler = handlers[c.id]
    if (!handler || ('palette' in c && c.palette === false)) return []
    const key = commandKeys(c.id)[0]
    return [
      {
        kind: 'command',
        id: c.id,
        label: label(handler.label ?? c.label),
        ...(key === undefined ? {} : { shortcut: shortcutLabel(key) }),
      },
    ]
  })
}

/**
 * Notebooks in sidebar order (each with its parent's name), tags, and notes
 * newest first (each with its notebook's name; untitled ones by `headlines`, as the list shows them).
 */
export function libraryEntries(source: {
  tree: readonly BookNode[]
  tags: readonly { id: string; name: string }[]
  notes: readonly NoteSummary[]
  /** The first line of untitled notes, by ID (see headlines.ts). */
  headlines: ReadonlyMap<string, string>
}): { book: PaletteEntry[]; tag: PaletteEntry[]; note: PaletteEntry[] } {
  const book: PaletteEntry[] = []
  const names = new Map<string, string>()
  const walk = (nodes: readonly BookNode[], parent: string | undefined) => {
    for (const n of nodes) {
      names.set(n.id, n.name)
      book.push({
        kind: 'book',
        id: n.id,
        label: n.name,
        ...(parent === undefined ? {} : { detail: parent }),
      })
      walk(n.children, n.name)
    }
  }
  walk(source.tree, undefined)
  const note = [...source.notes]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((n): PaletteEntry => {
      const name = n.bookId === null ? undefined : names.get(n.bookId)
      return {
        kind: 'note',
        id: n.id,
        label: displayTitle(n.title, source.headlines.get(n.id)),
        ...(name === undefined ? {} : { detail: name }),
      }
    })
  const tag = source.tags.map((t): PaletteEntry => ({ kind: 'tag', id: t.id, label: t.name }))
  return { book, tag, note }
}
