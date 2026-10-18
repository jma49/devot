// What the command palette can list: the window's commands, and its
// notebooks, tags and notes.
import type { NoteSummary } from '../../../core'
import type { BookNode } from '../../../core/books'
import { shortcutLabel } from '../commands/keys'
import { COMMANDS, commandKeys, type CommandHandlers } from '../commands/registry'
import { displayTitle } from '../headlines'
import type { MessageKey } from '../i18n'
import { PALETTE_SOURCES, SOURCE_KEYS, type PaletteEntry, type PaletteSource } from './results'

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
        description: label(`palette.group.${c.group}`),
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
        bookIcon: { icon: n.icon, color: n.iconColor },
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

/** The root's list: a row per source, with the key that scopes to it. */
export function sourceEntries(label: (key: MessageKey) => string): PaletteEntry[] {
  const names: Record<PaletteSource, MessageKey> = {
    command: 'palette.source.command',
    book: 'palette.source.book',
    tag: 'palette.source.tag',
    outline: 'palette.source.outline',
    note: 'palette.source.note',
  }
  return PALETTE_SOURCES.map((source): PaletteEntry => {
    const key = SOURCE_KEYS[source]
    return {
      kind: 'source',
      id: source,
      label: label(names[source]),
      ...(key === undefined ? {} : { shortcut: key }),
    }
  })
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const TASK = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\][ \t]+(.*\S)\s*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * The outline of a note's Markdown: its headings and task items in document
 * order. A heading's depth is its level less one; a task sits one deeper than
 * the heading above it (plus a step for each two spaces it is indented).
 * Front matter and code blocks are skipped.
 */
export function outlineEntries(markdown: string): PaletteEntry[] {
  const lines = markdown.split('\n')
  const out: PaletteEntry[] = []
  let at = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line))
    if (end > 0) at = end + 1
  }
  let fence: string | null = null
  let level = 0
  for (; at < lines.length; at += 1) {
    const line = lines[at] ?? ''
    const mark = FENCE.exec(line)?.[1]
    if (mark !== undefined) {
      if (fence === null) fence = mark
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null
      continue
    }
    if (fence !== null) continue
    const heading = HEADING.exec(line)
    if (heading) {
      level = (heading[1] ?? '#').length
      const text = (heading[2] ?? '').trim()
      if (text === '') continue
      out.push({
        kind: 'outline',
        id: `line:${at + 1}`,
        label: text,
        line: at + 1,
        level,
        depth: level - 1,
      })
      continue
    }
    const task = TASK.exec(line)
    if (task) {
      const indent = (task[1] ?? '').replace(/\t/g, '  ').length
      out.push({
        kind: 'outline',
        id: `line:${at + 1}`,
        label: (task[3] ?? '').trim(),
        line: at + 1,
        level: 0,
        depth: level + Math.floor(indent / 2),
        done: task[2] !== ' ',
      })
    }
  }
  return out
}

/** `query` with a clause that keeps only notes with the tag (unless it is already there). */
export function withTagClause(query: string, tagName: string): string {
  const clause = `tag:${/[\s"]/.test(tagName) ? `"${tagName.replaceAll('"', '')}"` : tagName}`
  if (query.split(/\s+/).includes(clause)) return query
  const base = query.trimEnd()
  return base === '' ? `${clause} ` : `${base} ${clause} `
}
