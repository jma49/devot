// What the quick capture window holds, kept in its webview's local storage
// on every change, so closing the window or quitting Devot before the note
// is saved loses nothing; cleared once the note is saved. Storage that is
// off keeps no draft and fails nothing.
import { NOTE_STATUSES, type NoteStatus } from '../../../core/storage'
import { MAX_TAG_NAME_CHARS, sameName } from '../../../core/tagNames'
import { charCount, trimWhitespace, wellFormed } from '../../../core/text'

export const MAX_CAPTURE_TAGS = 50

export interface CaptureDraft {
  title: string
  body: string
  bookId: string | null
  status?: NoteStatus
  tags?: string[]
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

function hasMeta(capture: Pick<CaptureDraft, 'status' | 'tags'>): boolean {
  return (
    (capture.status !== undefined && capture.status !== 'none') ||
    (capture.tags !== undefined && capture.tags.length > 0)
  )
}

export function normalizeQuickTag(raw: string): string | null {
  const withoutHash = raw.replace(/^\s*#+/, '')
  const cleaned = trimWhitespace(wellFormed(withoutHash))
  if (!cleaned || /[\r\n]/.test(cleaned) || charCount(cleaned) > MAX_TAG_NAME_CHARS) return null
  return cleaned
}

export function addQuickTag(
  tags: readonly string[],
  raw: string,
): { next: string[]; added: string | null } {
  const tag = normalizeQuickTag(raw)
  if (!tag || tags.length >= MAX_CAPTURE_TAGS || tags.some((existing) => sameName(existing, tag))) {
    return { next: [...tags], added: null }
  }
  return { next: [...tags, tag], added: tag }
}

/** Commits any pending comma-separated or `#`-prefixed tag text before close, blur or save. */
export function flushQuickTagDraft(tags: readonly string[], raw: string): string[] {
  if (raw.trim() === '') return [...tags]
  let current = [...tags]
  for (const part of raw.split(/,+/)) current = addQuickTag(current, part).next
  return current
}

export function readDraft(storage = local()): CaptureDraft | null {
  try {
    const stored: unknown = JSON.parse(storage?.getItem(KEY) ?? 'null')
    if (typeof stored !== 'object' || stored === null) return null
    const { title, body, bookId, status, tags } = stored as Record<string, unknown>
    if (typeof title !== 'string' || typeof body !== 'string') return null
    if (bookId !== null && typeof bookId !== 'string') return null
    let nextStatus: NoteStatus | undefined
    if (status !== undefined) {
      if (typeof status !== 'string' || !(NOTE_STATUSES as readonly unknown[]).includes(status)) {
        return null
      }
      if (status !== 'none') nextStatus = status as NoteStatus
    }
    let nextTags: string[] | undefined
    if (tags !== undefined) {
      if (!Array.isArray(tags) || tags.length > MAX_CAPTURE_TAGS) return null
      const cleaned: string[] = []
      for (const item of tags) {
        if (typeof item !== 'string') return null
        const normalized = normalizeQuickTag(item)
        if (!normalized) return null
        if (!cleaned.some((existing) => sameName(existing, normalized))) cleaned.push(normalized)
      }
      if (cleaned.length > 0) nextTags = cleaned
    }
    return {
      title,
      body,
      bookId,
      ...(nextStatus !== undefined ? { status: nextStatus } : {}),
      ...(nextTags !== undefined ? { tags: nextTags } : {}),
    }
  } catch {
    return null
  }
}

export function writeDraft(draft: CaptureDraft, storage = local()): void {
  if (isEmptyCapture(draft) && !hasMeta(draft)) return clearDraft(storage)
  try {
    const stored: CaptureDraft = {
      title: draft.title,
      body: draft.body,
      bookId: draft.bookId,
      ...(draft.status !== undefined && draft.status !== 'none' ? { status: draft.status } : {}),
      ...(draft.tags !== undefined && draft.tags.length > 0 ? { tags: draft.tags } : {}),
    }
    storage?.setItem(KEY, JSON.stringify(stored))
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
