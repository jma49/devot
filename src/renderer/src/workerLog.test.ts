import { describe, expect, it } from 'vitest'
import type { LogEntry } from './log'
import { forwardWorkerLogs, workerLogIn, type WorkerLogMessage } from './workerLog'

const NOTE_ID = '01920000-0000-7000-8000-000000000001'

function fakeScope() {
  const listeners = new Map<string, (e: unknown) => void>()
  const scope = {
    console: {
      warn: (..._args: unknown[]) => {},
      error: (..._args: unknown[]) => {},
    },
    addEventListener: (type: string, fn: (e: unknown) => void) => void listeners.set(type, fn),
  } as unknown as Parameters<typeof forwardWorkerLogs>[0]
  return { listeners, scope, workerConsole: scope.console }
}

describe('forwardWorkerLogs', () => {
  it('posts coded warnings and errors from the worker console', () => {
    const { scope, workerConsole } = fakeScope()
    const posted: WorkerLogMessage[] = []
    forwardWorkerLogs(scope, (message) => posted.push(message))
    workerConsole.warn('W_REVISION_FAILED', 'E_STORAGE_FULL')
    workerConsole.error('E_SOMETHING', NOTE_ID)
    workerConsole.warn('plain text from a library')
    expect(posted).toEqual([
      { workerLog: { level: 'warn', code: 'W_REVISION_FAILED', ids: ['E_STORAGE_FULL'] } },
      { workerLog: { level: 'error', code: 'E_SOMETHING', ids: [NOTE_ID] } },
    ])
  })

  it('posts uncaught errors and rejections under worker codes, by kind only', () => {
    const { scope, listeners } = fakeScope()
    const posted: WorkerLogMessage[] = []
    forwardWorkerLogs(scope, (message) => posted.push(message))
    listeners.get('error')?.({ error: new Error('cannot read "Diary"') })
    listeners.get('unhandledrejection')?.({ reason: new Error('E_NOTE_MISSING') })
    expect(posted.map((m) => m.workerLog)).toEqual([
      { level: 'error', code: 'E_WORKER_UNCAUGHT', ids: [] },
      { level: 'error', code: 'E_WORKER_UNHANDLED_REJECTION', ids: ['E_NOTE_MISSING'] },
    ])
  })
})

describe('workerLogIn', () => {
  it('reads the entry a worker message carries', () => {
    const entry: LogEntry = { level: 'warn', code: 'W_X', ids: [NOTE_ID] }
    expect(workerLogIn({ workerLog: entry })).toEqual(entry)
  })

  it('ignores other messages and anything that is not a code with IDs', () => {
    expect(workerLogIn({ saveProblems: [] })).toBeUndefined()
    expect(workerLogIn(null)).toBeUndefined()
    expect(
      workerLogIn({ workerLog: { level: 'warn', code: 'Diary entry', ids: [] } }),
    ).toBeUndefined()
    expect(workerLogIn({ workerLog: { level: 'debug', code: 'W_X', ids: [] } })).toBeUndefined()
    expect(
      workerLogIn({ workerLog: { level: 'warn', code: 'W_X', ids: ['my secret'] } })?.ids,
    ).toEqual([])
  })
})
