// Pasted and dropped images become attachments. The bytes go straight from
// the page to storage (not through the core worker); the note gets a
// Markdown image link to devot://file/<id>.
import { errorCode } from '../../core/errors'
import { attachmentMarkdown, checkUpload, MAX_FILE_BYTES } from '../../core/files'
import { createIdGenerator } from '../../core/ids'
import { storage } from './core-client'

const newId = createIdGenerator()

export function imageFiles(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? []).filter((f) => f.type.startsWith('image/'))
}

export interface StoredImages {
  links: string
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
      // Refused here what Rust would refuse, before the bytes are sent.
      if (file.size > MAX_FILE_BYTES) throw new Error('E_FILE_SIZE_INVALID')
      const data = new Uint8Array(await file.arrayBuffer())
      checkUpload(meta, data)
      await storage.putFile(meta, data)
      lines.push(attachmentMarkdown(meta))
    } catch (error) {
      const code = errorCode(error)
      console.warn('W_ATTACHMENT_REFUSED', code)
      refused.push(code)
    }
  }
  return { links: lines.join('\n'), refused }
}
