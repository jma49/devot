// Pasted and dropped images become attachments. The bytes go straight from
// the page to storage (not through the core worker); the note gets a
// Markdown image link to devot://file/<id>.
import { errorCode } from '../../core/errors'
import { attachmentMarkdown } from '../../core/files'
import { createIdGenerator } from '../../core/ids'
import { storage } from './core-client'

const newId = createIdGenerator()

/** Image files among a paste or drop's items. */
export function imageFiles(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? []).filter((f) => f.type.startsWith('image/'))
}

/** What storing a paste or drop's images gave. */
export interface StoredImages {
  /** The Markdown to insert, one image per line. */
  links: string
  /** The code of each image that could not be stored, in order. */
  refused: string[]
}

/**
 * Stores each image for the note. A file that could not be stored is
 * skipped, logged by code and listed in `refused`, for the window to report.
 */
export async function storeImages(noteId: string, files: readonly File[]): Promise<StoredImages> {
  const lines: string[] = []
  const refused: string[] = []
  for (const file of files) {
    const meta = { id: newId(), noteId, name: file.name || 'image' }
    try {
      await storage.putFile(meta, new Uint8Array(await file.arrayBuffer()))
      lines.push(attachmentMarkdown(meta))
    } catch (error) {
      const code = errorCode(error)
      console.warn('W_ATTACHMENT_REFUSED', code)
      refused.push(code)
    }
  }
  return { links: lines.join('\n'), refused }
}
