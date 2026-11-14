import { errorCode } from './errors'
import { attachmentMarkdown, checkUpload } from './files'
import type { NoteService } from './notes'
import type { StorageAdapter } from './storage'

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

export interface SharedImage {
  name: string
  data: Uint8Array
}

/** What the iPhone's Share Extension left in its inbox (docs/specs/share-extension.md). */
export interface SharedNote {
  title: string
  text: string
  url: string | null
  images: readonly SharedImage[]
  bookId: string | null
}

function sharedBody(text: string, url: string | null, links: readonly string[]): string {
  const kept = text.trimEnd()
  const parts = [kept, url !== null && !kept.includes(url) ? url : '', links.join('\n')]
  const body = parts.filter((part) => part !== '').join('\n\n')
  return body === '' ? '' : `${body}\n`
}

/**
 * Makes a note of a share, as captureNote does: its images become the note's attachments, linked
 * after its text and link. An image storage would refuse is skipped and its code listed in
 * `refused`; a share left with nothing to keep rejects with E_SHARE_EMPTY and makes no note.
 */
export async function captureShare(
  notes: NoteService,
  files: Pick<StorageAdapter, 'putFile'>,
  newId: () => string,
  share: SharedNote,
): Promise<{ id: string; refused: string[] }> {
  const refused: string[] = []
  const images = share.images.flatMap((image) => {
    try {
      checkUpload({ id: '', noteId: '', name: image.name }, image.data)
      return [image]
    } catch (error) {
      refused.push(errorCode(error))
      return []
    }
  })
  const url = share.url?.trim() || null
  if (share.title.trim() === '' && share.text.trim() === '' && url === null && images.length === 0)
    throw new Error('E_SHARE_EMPTY')
  const id = await notes.create(share.title, share.bookId)
  const links: string[] = []
  for (const image of images) {
    const meta = { id: newId(), noteId: id, name: image.name }
    try {
      await files.putFile(meta, image.data)
      links.push(attachmentMarkdown(meta))
    } catch (error) {
      refused.push(errorCode(error))
    }
  }
  const body = sharedBody(share.text, url, links)
  if (body !== '') await notes.setBody(id, body)
  await notes.flush().catch(() => {})
  return { id, refused }
}
