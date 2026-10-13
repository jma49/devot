import { describe, expect, it } from 'vitest'
import { errorCode } from './errors'

describe('errorCode', () => {
  it('takes the code an Error or a command starts with', () => {
    expect(errorCode(new Error('E_NOTE_NOT_FOUND'))).toBe('E_NOTE_NOT_FOUND')
    // Rust's commands reject with their code as a string.
    expect(errorCode('E_STORAGE_BUSY')).toBe('E_STORAGE_BUSY')
    // Only the code of a longer text: what follows may be anything.
    expect(errorCode('E_STORAGE_SCHEMA_TOO_NEW v13')).toBe('E_STORAGE_SCHEMA_TOO_NEW')
    expect(errorCode(new Error('E_NOTE_PUT: Diary 2026'))).toBe('E_NOTE_PUT')
    expect(errorCode('W_IMPORT_SKIPPED')).toBe('W_IMPORT_SKIPPED')
  })

  it('gives the fallback for anything without a code', () => {
    expect(errorCode(new Error('cannot read "Diary 2026"'))).toBe('E_UNKNOWN')
    expect(errorCode('Diary 2026')).toBe('E_UNKNOWN')
    expect(errorCode('E_NOTEabc')).toBe('E_UNKNOWN')
    expect(errorCode('E_')).toBe('E_UNKNOWN')
    expect(errorCode({ code: 'E_X', message: 'E_X' })).toBe('E_UNKNOWN')
    expect(errorCode(undefined, 'E_BATCH_NOTE')).toBe('E_BATCH_NOTE')
    expect(errorCode(null)).toBe('E_UNKNOWN')
  })
})
