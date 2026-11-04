import { afterEach, describe, expect, it, vi } from 'vitest'
import { refusedEdits } from './refusedEdits'

describe('refusedEdits', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports every refused edit with its code, logging each code once with the note ID', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const reported: [string, string][] = []
    const refused = refusedEdits('note-1', (id, code) => reported.push([id, code]))
    refused(new Error('E_NOTE_BODY_TOO_LARGE'))
    refused(new Error('E_NOTE_BODY_TOO_LARGE'))
    refused(new Error('E_NOTE_NOT_FOUND'))
    expect(reported).toEqual([
      ['note-1', 'E_NOTE_BODY_TOO_LARGE'],
      ['note-1', 'E_NOTE_BODY_TOO_LARGE'],
      ['note-1', 'E_NOTE_NOT_FOUND'],
    ])
    expect(warn.mock.calls).toEqual([
      ['W_NOTE_EDIT_REFUSED', 'note-1', 'E_NOTE_BODY_TOO_LARGE'],
      ['W_NOTE_EDIT_REFUSED', 'note-1', 'E_NOTE_NOT_FOUND'],
    ])
  })

  it('logs no text a refusal carries after its code', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    refusedEdits('note-1', () => undefined)(new Error('E_STORAGE_WRITE_FAILED secret words'))
    refusedEdits('note-1', () => undefined)(new Error('secret words'))
    expect(warn.mock.calls).toEqual([
      ['W_NOTE_EDIT_REFUSED', 'note-1', 'E_STORAGE_WRITE_FAILED'],
      ['W_NOTE_EDIT_REFUSED', 'note-1', 'E_UNKNOWN'],
    ])
  })
})
