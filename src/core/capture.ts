import type { NoteService } from './notes'

export interface QuickCapture {
  title: string
  markdown: string
  bookId: string | null
}

/**
 * Makes a note of a quick capture (menu bar mode) and saves it before it
 * resolves. A notebook that is gone rejects with E_BOOK_NOT_FOUND and makes
 * no note, so the capture window keeps the text to file elsewhere. A save
 * that fails after the note is made does not reject: the note stays pending
 * in the core, which retries it and reports it like any unsaved edit, and a
 * capture sent again would only make it twice.
 */
export async function captureNote(notes: NoteService, capture: QuickCapture): Promise<string> {
  if (capture.title.trim() === '' && capture.markdown.trim() === '')
    throw new Error('E_QUICK_CAPTURE_EMPTY')
  const id = await notes.create(capture.title, capture.bookId)
  if (capture.markdown !== '') await notes.setBody(id, capture.markdown)
  await notes.flush().catch(() => {})
  return id
}
