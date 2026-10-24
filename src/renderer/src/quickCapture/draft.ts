// What the quick capture window holds, kept in its webview's local storage
// on every change, so closing the window or quitting Devot before the note
// is saved loses nothing; cleared once the note is saved. Storage that is
// off keeps no draft and fails nothing.

export interface CaptureDraft {
  title: string
  body: string
  bookId: string | null
}

const KEY = 'devot.quickCapture.draft'

interface KeyValue {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function local(): KeyValue | undefined {
  try {
    return (globalThis as { localStorage?: KeyValue }).localStorage
  } catch {
    return undefined
  }
}

export function isEmptyCapture(capture: Pick<CaptureDraft, 'title' | 'body'>): boolean {
  return capture.title.trim() === '' && capture.body.trim() === ''
}

export function readDraft(storage = local()): CaptureDraft | null {
  try {
    const stored: unknown = JSON.parse(storage?.getItem(KEY) ?? 'null')
    if (typeof stored !== 'object' || stored === null) return null
    const { title, body, bookId } = stored as Record<string, unknown>
    if (typeof title !== 'string' || typeof body !== 'string') return null
    if (bookId !== null && typeof bookId !== 'string') return null
    return { title, body, bookId }
  } catch {
    return null
  }
}

export function writeDraft(draft: CaptureDraft, storage = local()): void {
  if (isEmptyCapture(draft)) return clearDraft(storage)
  try {
    storage?.setItem(KEY, JSON.stringify(draft))
  } catch {
    // The window still holds the text.
  }
}

export function clearDraft(storage = local()): void {
  try {
    storage?.removeItem(KEY)
  } catch {
    // Nothing to keep.
  }
}

/**
 * The notebook the window offers: the one picked (no notebook included)
 * while it exists, else the default notebook while it exists, else none.
 * `picked` is undefined until the user picks one.
 */
export function notebookToShow(
  picked: string | null | undefined,
  defaultNotebook: string | null,
  ids: readonly string[],
): string | null {
  if (picked === null) return null
  if (picked !== undefined && ids.includes(picked)) return picked
  return defaultNotebook !== null && ids.includes(defaultNotebook) ? defaultNotebook : null
}
