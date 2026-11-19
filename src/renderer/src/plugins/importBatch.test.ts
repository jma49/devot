import { expect, it } from 'vitest'
import type { ImportReport } from '../../../core/import'
import { importBatch } from './importBatch'

const report = (problems: ImportReport['problems'] = []): ImportReport => ({
  bookId: null,
  notes: 1,
  noteIds: { '1.md': 'note-1' },
  books: 0,
  attachments: 0,
  links: 0,
  unresolvedLinks: 0,
  problems,
})

it('stops the whole selected-file batch when a worker import reports quit cancellation', async () => {
  const called: string[] = []
  const result = await importBatch(['first', 'second'], async (file) => {
    called.push(file)
    return report([{ path: '2.md', code: 'E_IMPORT_STOPPED' }])
  })
  expect(called).toEqual(['first'])
  expect(result.made).toBe(1)
  expect(result.error).toEqual(new Error('E_IMPORT_STOPPED'))
})

it('continues after a file error and keeps per-note diagnostics from successful files', async () => {
  const result = await importBatch(['bad', 'good'], async (file) => {
    if (file === 'bad') throw new Error('E_IMPORT_ENEX_XML')
    return report([{ path: '1.md', code: 'E_IMPORT_ENCRYPTED', noteId: 'note-1' }])
  })
  expect(result.made).toBe(1)
  expect(result.problems).toHaveLength(1)
  expect(result.error).toEqual(new Error('E_IMPORT_ENEX_XML'))
})

it('handles an empty batch and stops on a stopped converter', async () => {
  expect(await importBatch([], async () => report())).toEqual({
    made: 0,
    problems: [],
    error: undefined,
  })
  let calls = 0
  const result = await importBatch(['first', 'second'], async () => {
    calls++
    throw new Error('E_PLUGIN_STOPPED')
  })
  expect(calls).toBe(1)
  expect(result.error).toEqual(new Error('E_PLUGIN_STOPPED'))
})
