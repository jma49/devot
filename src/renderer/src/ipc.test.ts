import { afterEach, describe, expect, it } from 'vitest'
import { invoke } from './ipc'

type Answer = (cmd: string, args: unknown) => Promise<unknown>
const global = globalThis as { window?: unknown }

function commands(answer: Answer) {
  global.window = { __TAURI_INTERNALS__: { invoke: answer } }
}

afterEach(() => {
  delete global.window
})

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  )

describe('invoke', () => {
  it('rejects with an Error whose message is the code the command sent', async () => {
    commands(() => Promise.reject('E_STORAGE_BUSY'))
    const error = await rejection(invoke('note_get', { id: 'x' }))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('E_STORAGE_BUSY')
  })

  it('keeps only the code, whatever follows it', async () => {
    commands(() => Promise.reject('E_STORAGE_SCHEMA_TOO_NEW v13'))
    expect(((await rejection(invoke('backup_restore'))) as Error).message).toBe(
      'E_STORAGE_SCHEMA_TOO_NEW',
    )
    commands(() => Promise.reject(new Error('E_TEST_UNMOCKED_COMMAND note_get')))
    expect(((await rejection(invoke('note_get'))) as Error).message).toBe('E_TEST_UNMOCKED_COMMAND')
  })

  it('gives a failure without a code a code of its own', async () => {
    // Tauri's own failures (a missing command, arguments that do not fit)
    // can quote what was sent: that text is never the message.
    const text = 'invalid args `note` for command `note_put`: Diary 2026'
    commands(() => Promise.reject(text))
    const error = (await rejection(invoke('note_put'))) as Error
    expect(error.message).toBe('E_COMMAND_FAILED')
    expect(error.cause).toBe(text)
  })

  it('passes arguments and answers through', async () => {
    const seen: unknown[] = []
    commands(async (cmd, args) => {
      seen.push(cmd, args)
      return 42
    })
    expect(await invoke<number>('notes_list', { a: 1 })).toBe(42)
    expect(seen).toEqual(['notes_list', { a: 1 }])
  })
})
