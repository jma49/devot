// The notebooks the Settings window can offer (General > Default Notebook).
// The library lives in the main window's core, which the Settings window
// cannot reach, so the main window keeps the notebook names (never note
// content) in this webview's local storage, where the Settings window reads
// them and follows changes (a `storage` event). A view preference only: it
// holds nothing that needs to survive, and storage that is off means an
// empty list.
import type { BookNode } from '../../core/books'

export interface NotebookChoice {
  id: string
  name: string
  depth: number
}

const KEY = 'devot.notebookChoices'

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

export function publishNotebooks(choices: readonly NotebookChoice[], storage = local()): void {
  try {
    const json = JSON.stringify(choices)
    if (storage?.getItem(KEY) !== json) storage?.setItem(KEY, json)
  } catch {
    // The Settings window then offers no notebook.
  }
}

export function readNotebooks(storage = local()): NotebookChoice[] {
  try {
    const stored: unknown = JSON.parse(storage?.getItem(KEY) ?? '[]')
    if (!Array.isArray(stored)) return []
    return stored.filter(
      (c): c is NotebookChoice =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as NotebookChoice).id === 'string' &&
        typeof (c as NotebookChoice).name === 'string' &&
        Number.isInteger((c as NotebookChoice).depth),
    )
  } catch {
    return []
  }
}

export function subscribeNotebooks(notify: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) notify()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
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
