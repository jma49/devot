import { describe, expect, it, vi } from 'vitest'
import type { ImportScan, ImportSource } from '../../core'
import type { Core } from './core-client'
import { runImport } from './importer'
import { invoke } from './ipc'

vi.mock('./ipc', () => ({ invoke: vi.fn<() => Promise<null>>().mockResolvedValue(null) }))

const scan: ImportScan = {
  id: -1,
  name: '',
  kind: 'files',
  files: [{ path: 'a.md', bytes: 1 }],
  images: [],
  skipped: [],
}
const source: ImportSource = { read: async () => '# Note', attach: async () => {} }

describe('import sources', () => {
  it.each(['success', 'empty', 'failure'] as const)(
    'cleans a browser source on %s without closing a Rust session',
    async (result) => {
      vi.mocked(invoke).mockClear()
      const cleanup = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
      const core = {
        importMarkdown: async () => {
          if (result === 'failure') throw new Error('E_IMPORT_FAILED')
          return { notes: 1 }
        },
      } as unknown as Core
      const work = runImport(
        core,
        result === 'empty' ? { ...scan, files: [] } : scan,
        null,
        () => {},
        undefined,
        { source, cleanup },
      )
      const outcome = await work.then(
        (value) => value,
        (error: Error) => error.message,
      )
      expect(outcome).toEqual(
        { success: { notes: 1 }, empty: null, failure: 'E_IMPORT_FAILED' }[result],
      )
      expect(cleanup).toHaveBeenCalledOnce()
      expect(invoke).not.toHaveBeenCalled()
    },
  )

  it('keeps the Rust session as the default and closes even an empty scan', async () => {
    vi.mocked(invoke).mockClear()
    await runImport({} as Core, { ...scan, id: 1, files: [] }, null, () => {})
    expect(invoke).toHaveBeenCalledExactlyOnceWith('import_finish', { id: 1 })
  })
})
