import { describe, expect, it, vi } from 'vitest'
import type { HttpApiCall } from '../../core/httpApi'
import { httpApiHost } from './httpApiHost'

const READ = { id: 1, op: 'notes.read', note: 'n1', args: {} }
const TRASH = { id: 2, op: 'notes.trash', note: 'n1', args: {} }

function host(run: (call: HttpApiCall) => Promise<unknown>) {
  const reply = vi.fn<(id: number, result: unknown, error: string | null) => Promise<void>>(
    async () => {},
  )
  const wrote = vi.fn<() => void>()
  return { take: httpApiHost({ run, reply, wrote }), reply, wrote }
}

describe('httpApiHost', () => {
  it("runs the call and answers its ID with the core's JSON", async () => {
    const h = host(async (call) => ({ id: call.note, title: 'Plan' }))
    await h.take(READ)
    expect(h.reply).toHaveBeenCalledWith(1, { id: 'n1', title: 'Plan' }, null)
    expect(h.wrote).not.toHaveBeenCalled()
  })

  it('answers a failure with its code alone', async () => {
    const h = host(() => Promise.reject(new Error('E_NOTE_NOT_FOUND n1 some text')))
    await h.take(READ)
    expect(h.reply).toHaveBeenCalledWith(1, null, 'E_NOTE_NOT_FOUND')
    const other = host(() => Promise.reject(new Error('no code here')))
    await other.take(READ)
    expect(other.reply).toHaveBeenCalledWith(1, null, 'E_HTTP_API_FAILED')
  })

  it('takes a write in as an outside change once it is made, and only then', async () => {
    const h = host(async () => ({ trashed: true }))
    await h.take(TRASH)
    expect(h.wrote).toHaveBeenCalledTimes(1)
    const failing = host(() => Promise.reject(new Error('E_NOTE_NOT_FOUND')))
    await failing.take(TRASH)
    expect(failing.wrote).not.toHaveBeenCalled()
  })

  it('runs calls one at a time, in the order they came', async () => {
    const order: string[] = []
    let release: () => void = () => {}
    const first = new Promise<void>((resolve) => (release = resolve))
    const h = host(async (call) => {
      order.push(`start ${call.op}`)
      if (call.op === 'notes.read') await first
      order.push(`end ${call.op}`)
      return {}
    })
    void h.take(READ)
    const done = h.take(TRASH)
    await Promise.resolve()
    release()
    await done
    expect(order).toEqual([
      'start notes.read',
      'end notes.read',
      'start notes.trash',
      'end notes.trash',
    ])
  })

  it('ignores a payload that is not a request', async () => {
    const run = vi.fn<(call: HttpApiCall) => Promise<unknown>>(async () => ({}))
    const h = host(run)
    await h.take({ id: 'x', op: 'notes.read' })
    await h.take({ ...READ, op: 'notes.purge' })
    expect(run).not.toHaveBeenCalled()
    expect(h.reply).not.toHaveBeenCalled()
  })

  it('goes on when Rust no longer waits for an answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reply = vi.fn<() => Promise<unknown>>(() =>
      Promise.reject(new Error('E_HTTP_API_UNKNOWN')),
    )
    const take = httpApiHost({ run: async () => ({}), reply, wrote: () => {} })
    await take(READ)
    await take(TRASH)
    expect(reply).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith('W_HTTP_API_ANSWER_FAILED', 'E_HTTP_API_UNKNOWN')
    warn.mockRestore()
  })
})
