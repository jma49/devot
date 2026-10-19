// Attachments: images pasted or dropped into a note. The format is read from the bytes (the same rules as the Rust store, commands/files.rs); SVG and anything that
// is not a known raster image are refused.

export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_FILE_NAME_CHARS = 200

export interface FileMeta {
  id: string
  noteId: string
  name: string
}

export interface FileCopy {
  from: string
  to: string
}

export const FILE_ID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}'

const FILE_LINK = new RegExp(`devot://file/(${FILE_ID_SOURCE})(?![0-9a-f-])`, 'g')

export function fileUri(id: string): string {
  return `devot://file/${id}`
}

/** An ID that appears twice is listed twice. Anything after the ID, such as a size preset (`#half`), is not part of it. */
export function fileLinkSpans(markdown: string): { id: string; index: number }[] {
  return Array.from(markdown.matchAll(FILE_LINK), (m) => {
    const id = m[1] as string
    return { id, index: m.index + m[0].length - id.length }
  })
}

export function fileLinks(markdown: string): string[] {
  return [...new Set(fileLinkSpans(markdown).map((span) => span.id))]
}

/** Attachments belong to one note, so a note made from another note's text needs its own copies. */
export function newFileCopies(markdown: string, newId: () => string): FileCopy[] {
  return fileLinks(markdown).map((from) => ({ from, to: newId() }))
}

export function replaceFileLinks(markdown: string, copies: readonly FileCopy[]): string {
  const ids = new Map(copies.map((c) => [c.from, c.to]))
  return markdown.replace(FILE_LINK, (uri, id: string) => {
    const to = ids.get(id)
    return to === undefined ? uri : fileUri(to)
  })
}

const ascii = (bytes: Uint8Array, start: number, text: string) =>
  [...text].every((c, i) => bytes[start + i] === c.charCodeAt(0))

/** Null when the bytes are no supported raster image. */
export function detectImage(bytes: Uint8Array): string | null {
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) {
    return 'image/png'
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'image/gif'
  if (bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'image/webp'
  if (bytes.length >= 12 && ascii(bytes, 4, 'ftyp')) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12))
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (['heic', 'heix', 'mif1', 'msf1'].includes(brand)) return 'image/heic'
  }
  return null
}

/** Returns the MIME type or throws an error code. */
export function checkUpload(meta: FileMeta, data: Uint8Array): string {
  const name = meta.name
  if (!name || [...name].length > MAX_FILE_NAME_CHARS || /\p{Cc}/u.test(name)) {
    throw new Error('E_FILE_NAME_INVALID')
  }
  if (data.length === 0 || data.length > MAX_FILE_BYTES) throw new Error('E_FILE_SIZE_INVALID')
  const mime = detectImage(data)
  if (!mime) throw new Error('E_FILE_TYPE_REFUSED')
  return mime
}

export function attachmentMarkdown(meta: FileMeta): string {
  const alt = meta.name.replace(/\.[^.]+$/, '').replace(/[[\]\\]/g, '')
  return `![${alt}](${fileUri(meta.id)})`
}
