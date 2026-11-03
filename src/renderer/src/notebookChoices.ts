// The notebooks and templates the Settings window can offer (General > Default Notebook, Daily
// Notes).
// The library lives in the main window's core, which the Settings window
// cannot reach, so the main window keeps the notebook names and template
// titles (never note content) in this webview's local storage, where the Settings window reads
// them and follows changes (a `storage` event). A view preference only: it
// holds nothing that needs to survive, and storage that is off means an
// empty list.
import type { BookNode } from '../../core/books'

export interface NotebookChoice {
  id: string
  name: string
  depth: number
}

export interface TemplateChoice {
  id: string
  title: string
}

const KEY = 'devot.notebookChoices'
const TEMPLATES_KEY = 'devot.templateChoices'

interface KeyValue {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function local(): KeyValue | undefined {
  try {
    return (globalThis as { localStorage?: KeyValue }).localStorage
  } catch {
    return undefined
  }
}

export function choicesFromTree(tree: readonly BookNode[]): NotebookChoice[] {
  const out: NotebookChoice[] = []
  const walk = (nodes: readonly BookNode[]) => {
    for (const node of nodes) {
      out.push({ id: node.id, name: node.name, depth: node.depth })
      walk(node.children)
    }
  }
  walk(tree)
  return out
}

function publish(key: string, choices: readonly unknown[], storage: KeyValue | undefined): void {
  try {
    const json = JSON.stringify(choices)
    if (storage?.getItem(key) !== json) storage?.setItem(key, json)
  } catch {
    // The Settings window then offers none.
  }
}

function read<T>(key: string, valid: (c: Record<string, unknown>) => boolean, storage?: KeyValue) {
  try {
    const stored: unknown = JSON.parse(storage?.getItem(key) ?? '[]')
    if (!Array.isArray(stored)) return []
    return stored.filter(
      (c): c is T => typeof c === 'object' && c !== null && valid(c as Record<string, unknown>),
    )
  } catch {
    return []
  }
}

function subscribe(key: string, notify: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === key || e.key === null) notify()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}

export function publishNotebooks(choices: readonly NotebookChoice[], storage = local()): void {
  publish(KEY, choices, storage)
}

export function readNotebooks(storage = local()): NotebookChoice[] {
  return read<NotebookChoice>(
    KEY,
    (c) => typeof c.id === 'string' && typeof c.name === 'string' && Number.isInteger(c.depth),
    storage,
  )
}

export function subscribeNotebooks(notify: () => void): () => void {
  return subscribe(KEY, notify)
}

export function publishTemplates(choices: readonly TemplateChoice[], storage = local()): void {
  publish(TEMPLATES_KEY, choices, storage)
}

export function readTemplates(storage = local()): TemplateChoice[] {
  return read<TemplateChoice>(
    TEMPLATES_KEY,
    (c) => typeof c.id === 'string' && typeof c.title === 'string',
    storage,
  )
}

export function subscribeTemplates(notify: () => void): () => void {
  return subscribe(TEMPLATES_KEY, notify)
}

/**
 * The notebook a new note goes to: the notebook the view shows, else the
 * default notebook when it still exists, else none.
 */
export function notebookForNewNote(
  viewBookId: string | null | undefined,
  defaultBookId: string | null,
  bookIds: readonly string[],
): string | null {
  if (viewBookId) return viewBookId
  return defaultBookId !== null && bookIds.includes(defaultBookId) ? defaultBookId : null
}
