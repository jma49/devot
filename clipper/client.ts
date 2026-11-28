import { toBase64 } from '../src/core/base64'
import { detectImage } from '../src/core/files'
import { hasRemoteImages, storeImageLinks } from './images'
import { mayDownload } from './network'

export const MAX_IMAGE_BYTES = Math.floor((2 * 1024 * 1024 - 4096) / 4) * 3

async function downloadImage(url: string): Promise<{ name: string; type: string; data: string }> {
  const response = await fetch(url, {
    credentials: 'omit',
    signal: AbortSignal.timeout(20000),
  })
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get('Content-Length')) > MAX_IMAGE_BYTES
  ) {
    await response.body?.cancel()
    throw new Error('E_FILE_SIZE_INVALID')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_IMAGE_BYTES) throw new Error('E_FILE_SIZE_INVALID')
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  const type = detectImage(bytes)
  if (!type) throw new Error('E_FILE_TYPE_REFUSED')
  return { name: `image.${type.slice(6)}`, type, data: toBase64(bytes) }
}

export interface Settings {
  port: number
  token: string
}
export interface Note {
  title: string
  markdown: string
  notebook: string
}
export interface Saved {
  id: string
  imagesKept: boolean
}
export interface Notebook {
  id: string
  name: string
  notes: number
}
export const MAX_MARKDOWN_BYTES = 1024 * 1024

export function checkMarkdown(markdown: string): void {
  if (new TextEncoder().encode(markdown).length > MAX_MARKDOWN_BYTES)
    throw new Error('E_NOTE_BODY_TOO_LARGE')
}

export class ApiClient {
  constructor(
    private readonly settings: Settings,
    private readonly origin?: string,
  ) {}

  private async request(
    path: string,
    body?: unknown,
    method = body ? 'POST' : 'GET',
  ): Promise<unknown> {
    const { port, token } = this.settings
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !token.trim())
      throw new Error('E_CLIP_SETTINGS')
    let response: Response
    try {
      response = await fetch(`http://127.0.0.1:${port}/v1/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(this.origin ? { Origin: this.origin } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      })
    } catch {
      throw new Error('E_CLIP_CONNECTION')
    }
    const result = (await response.json()) as { error?: string }
    if (!response.ok) throw new Error(result.error || 'E_CLIP_API')
    return result
  }

  async notebooks(): Promise<Notebook[]> {
    return ((await this.request('notebooks')) as { notebooks: Notebook[] }).notebooks
  }

  /**
   * Whether the token may write, without writing: Rust refuses a read-only token before it reads
   * the body, so an empty object comes back `E_HTTP_BODY_INVALID` only for a read/write token.
   */
  async checkWrite(): Promise<void> {
    try {
      await this.request('notes', {})
    } catch (error) {
      if (error instanceof Error && error.message === 'E_HTTP_BODY_INVALID') return
      throw error
    }
    throw new Error('E_CLIP_API')
  }

  /**
   * Makes the note, then stores the images of the page at `imagesFrom`, or none without it. Once the
   * note exists nothing that goes wrong with images fails the save, so a retry never makes a second
   * copy; `imagesKept` says some stayed remote.
   */
  async save(
    note: Note,
    imagesFrom?: string,
    progress: (done: number, total: number) => void = () => {},
  ): Promise<Saved> {
    checkMarkdown(note.markdown)
    const made = (await this.request('notes', note)) as { id: string }
    if (!imagesFrom) return { id: made.id, imagesKept: hasRemoteImages(note.markdown) }
    try {
      const markdown = await storeImageLinks(
        note.markdown,
        async (url) => {
          if (!mayDownload(url, imagesFrom)) throw new Error('E_CLIP_LOCAL_IMAGE')
          const image = await downloadImage(url)
          await new Promise((resolve) => setTimeout(resolve, 120))
          const file = (await this.request(
            `notes/${encodeURIComponent(made.id)}/files`,
            image,
          )) as { url: string }
          if (!/^devot:\/\/file\//.test(file.url)) throw new Error('E_CLIP_API')
          return file.url
        },
        progress,
      )
      if (markdown !== note.markdown) {
        checkMarkdown(markdown)
        const path = `notes/${encodeURIComponent(made.id)}`
        const current = (await this.request(path)) as { markdown: string }
        if (current.markdown !== note.markdown) return { id: made.id, imagesKept: true }
        await this.request(path, { markdown }, 'PATCH')
      }
      return { id: made.id, imagesKept: hasRemoteImages(markdown) }
    } catch {
      return { id: made.id, imagesKept: true }
    }
  }
}
