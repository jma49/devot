import { describe, expect, it, vi } from 'vitest'
import { forwardConsole, forwardUncaught, logEntry, type LogEntry } from './log'

const NOTE_ID = '01920000-0000-7000-8000-000000000001'

describe('logEntry', () => {
  it('keeps the code and IDs only', () => {
    expect(logEntry('warn', ['W_NOTE_OPEN_FAILED', NOTE_ID])).toEqual({
      level: 'warn',
      code: 'W_NOTE_OPEN_FAILED',
      ids: [NOTE_ID],
    })
    expect(logEntry('warn', ['W_BOOK_CHANGE_FAILED', 'E_BOOK_CYCLE'])?.ids).toEqual([
      'E_BOOK_CYCLE',
    ])
  })

  it('drops anything that could be note content', () => {
    expect(logEntry('warn', ['W_SYMBOL_UNAVAILABLE', 'Groceries', 'my secret'])?.ids).toEqual([])
    expect(logEntry('warn', ['W_X', new Error('title: Diary')])?.ids).toEqual([])
    expect(logEntry('warn', ['Diary entry'])).toBeUndefined()
    expect(logEntry('error', [{ code: 'E_X' }])).toBeUndefined()
  })

  it('takes a code from an error message, and at most four IDs', () => {
    expect(logEntry('warn', ['W_ATTACHMENT_REFUSED', 'E_FILE_TOO_LARGE'])?.ids).toEqual([
      'E_FILE_TOO_LARGE',
    ])
    // Only the code a longer text starts with.
    expect(
      logEntry('warn', ['W_BACKUP_RESTORE_FAILED', new Error('E_STORAGE_SCHEMA_TOO_NEW v13')])?.ids,
    ).toEqual(['E_STORAGE_SCHEMA_TOO_NEW'])
    expect(logEntry('warn', ['W_X', 'E_STORAGE_SCHEMA_TOO_NEW v13'])?.ids).toEqual([
      'E_STORAGE_SCHEMA_TOO_NEW',
    ])
    expect(logEntry('warn', ['W_X', ...Array<string>(6).fill(NOTE_ID)])?.ids).toHaveLength(4)
  })
})

describe('forwardConsole', () => {
  function fakeConsole() {
    return {
      warn: vi.fn<(...args: unknown[]) => void>(),
      error: vi.fn<(...args: unknown[]) => void>(),
    }
  }

  it('sends coded warnings and errors and still prints them', async () => {
    const target = fakeConsole()
    const printWarn = target.warn
    const sent: LogEntry[] = []
    forwardConsole(target, async (e) => void sent.push(e))
    target.warn('W_PREVIEW_RENDER_FAILED')
    target.error('E_SOMETHING', NOTE_ID)
    target.warn('plain text from a library')
    expect(printWarn).toHaveBeenCalledTimes(2)
    expect(sent).toEqual([
      { level: 'warn', code: 'W_PREVIEW_RENDER_FAILED', ids: [] },
      { level: 'error', code: 'E_SOMETHING', ids: [NOTE_ID] },
    ])
  })

  it('ignores a failing send', async () => {
    const target = fakeConsole()
    forwardConsole(target, () => Promise.reject(new Error('E_OFFLINE')))
    expect(() => target.warn('W_X')).not.toThrow()
    await Promise.resolve()
  })
})

describe('forwardUncaught', () => {
  it('logs uncaught errors by kind, keeping only a code from the message', () => {
    const listeners = new Map<string, (e: unknown) => void>()
    const target = {
      addEventListener: (type: string, fn: (e: unknown) => void) => void listeners.set(type, fn),
    } as unknown as Pick<Window, 'addEventListener'>
    const sent: LogEntry[] = []
    forwardUncaught(target, async (e) => void sent.push(e))
    listeners.get('error')?.({ error: new Error('cannot read "Diary"') })
    listeners.get('unhandledrejection')?.({ reason: new Error('E_NOTE_MISSING') })
    expect(sent).toEqual([
      { level: 'error', code: 'E_UI_UNCAUGHT', ids: [] },
      { level: 'error', code: 'E_UI_UNHANDLED_REJECTION', ids: ['E_NOTE_MISSING'] },
    ])
  })
})
