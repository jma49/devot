export interface Settings {
  port: number
  token: string
}
export interface Note {
  title: string
  markdown: string
  notebook: string
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

  private async request(path: string, note?: Note): Promise<unknown> {
    const { port, token } = this.settings
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !token.trim())
      throw new Error('E_CLIP_SETTINGS')
    let response: Response
    try {
      response = await fetch(`http://127.0.0.1:${port}/v1/${path}`, {
        method: note ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(this.origin ? { Origin: this.origin } : {}),
          ...(note ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(note ? { body: JSON.stringify(note) } : {}),
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

  async save(note: Note): Promise<{ id: string }> {
    checkMarkdown(note.markdown)
    return (await this.request('notes', note)) as { id: string }
  }
}
