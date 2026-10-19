// The hidden window of `devot export` (src-tauri/src/cli_export.rs). It
// renders with the core library directly: there is no database to start
// the core worker on.
import { errorCode } from '../../core/errors'
import { renderPreview } from '../../core/preview'
import { notePage } from './exporter'
import { invoke } from './ipc'

export interface ExportSource {
  markdown: string
  title: string | null
  simple: boolean
  print: boolean
}

export function readSource(value: unknown): ExportSource | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { markdown, title, simple, print } = value as Record<string, unknown>
  if (typeof markdown !== 'string' || typeof simple !== 'boolean' || typeof print !== 'boolean')
    return undefined
  if (title !== null && typeof title !== 'string') return undefined
  return { markdown, title, simple, print }
}

export async function exportPage(source: ExportSource): Promise<string> {
  const page = await notePage(
    (markdown, options) => renderPreview(markdown, options),
    { title: source.title ?? '', bodyMd: source.markdown },
    { simple: source.simple, print: source.print },
  )
  return page.html
}

export async function runExport(): Promise<void> {
  try {
    await makePage()
  } catch (error) {
    await invoke('cli_export_fail', { code: errorCode(error, 'E_CLI_EXPORT_FAILED') }).catch(() =>
      console.warn('W_CLI_EXPORT_FAIL_UNSENT'),
    )
  }
}

async function makePage() {
  const source = readSource(await invoke<unknown>('cli_export_source'))
  if (!source) throw new Error('E_CLI_EXPORT_SOURCE_INVALID')
  await invoke('cli_export_finish', { html: await exportPage(source) })
}
