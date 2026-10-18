import { noteUri } from '../../core/links'
import { noteLinks } from './noteMenu'

/**
 * Drag payloads. Note rows carry their IDs (one per line) and notebook rows
 * their ID in private types that only Devot reads; a drag of templates also
 * carries DRAG_TEMPLATE: a status or tag row does not take templates (their
 * own status and tags are not used). Other apps get plain text (and HTML for
 * notes), so a drag out of the window drops links.
 */
export const DRAG_NOTE = 'application/x-devot-note'
export const DRAG_TEMPLATE = 'application/x-devot-template'
export const DRAG_BOOK = 'application/x-devot-book'

interface DragNote {
  id: string
  /** The display title (see `displayTitle`). */
  title: string
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The links of `notes` as HTML anchors, one per line break. */
export function noteDragHtml(notes: readonly DragNote[]): string {
  return notes
    .map((n) => `<a href="${escapeHtml(noteUri(n.id))}">${escapeHtml(n.title)}</a>`)
    .join('<br>')
}

/**
 * Puts a note drag on `dt`: the IDs for Devot's own targets, Markdown links
 * (`text/plain`) and anchors (`text/html`) for other apps. The effect must
 * allow copy: other apps refuse a move-only drop. Devot's own targets answer
 * with `dropEffect = 'move'`, which `copyMove` allows.
 */
export function setNoteDragData(dt: DataTransfer, notes: readonly DragNote[]): void {
  dt.setData(DRAG_NOTE, notes.map((n) => n.id).join('\n'))
  dt.setData('text/plain', noteLinks(notes))
  dt.setData('text/html', noteDragHtml(notes))
  dt.effectAllowed = 'copyMove'
}

/** Puts a notebook drag on `dt`: its ID, and `Name:<id>` as text. */
export function setBookDragData(dt: DataTransfer, book: { id: string; name: string }): void {
  dt.setData(DRAG_BOOK, book.id)
  dt.setData('text/plain', `${book.name}:${book.id}`)
  dt.effectAllowed = 'copyMove'
}
