// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { followRustState, type RustState } from './rustState'
import { settle } from '../../../tests/support/render-hook'
import { mockTauri } from '../../../tests/support/tauri-events'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', false))

let tauri: ReturnType<typeof mockTauri>
let made = 0
afterEach(() => tauri.clear())

function state(read: () => Promise<unknown>, over: Partial<RustState> = {}) {
  made += 1
  const taken: unknown[] = []
  return {
    taken,
    state: {
      event: `devot://test-changed-${made}`,
      pageEvent: `devot:test-changed-${made}`,
      read,
      take: (value: unknown) => void taken.push(value),
      readFailed: 'W_TEST_READ_FAILED',
      listenFailed: 'W_TEST_LISTEN_FAILED',
      ...over,
    },
  }
}

describe('followRustState', () => {
  it('reads only once it hears Rust', async () => {
    tauri = mockTauri()
    tauri.hold()
    const read = vi.fn<() => Promise<unknown>>(async () => 'S1')
    const { state: s, taken } = state(read)
    const followed = followRustState(s)
    await settle()
    expect(read).not.toHaveBeenCalled()
    tauri.release()
    await followed
    expect(taken).toEqual(['S1'])
    tauri.emit(s.event, 'S2')
    expect(taken).toEqual(['S1', 'S2'])
  })

  it('drops a read answered after an event when the state has no revision', async () => {
    tauri = mockTauri()
    let answer: (value: unknown) => void = () => {}
    const { state: s, taken } = state(() => new Promise((resolve) => (answer = resolve)), {
      unrevisioned: true,
    })
    const followed = followRustState(s)
    await settle()
    tauri.emit(s.event, 'S2')
    answer('S1')
    await followed
    expect(taken).toEqual(['S2'])
  })

  it('takes a read sent after the window last heard of a change', async () => {
    tauri = mockTauri()
    tauri.hold()
    const { state: s, taken } = state(async () => 'S2', { unrevisioned: true })
    const followed = followRustState(s)
    await settle()
    window.dispatchEvent(new CustomEvent(s.pageEvent, { detail: 'S1' }))
    tauri.release()
    await followed
    expect(taken).toEqual(['S1', 'S2'])
  })

  it('hands a revisioned state every reply, for its store to order', async () => {
    tauri = mockTauri()
    let answer: (value: unknown) => void = () => {}
    const { state: s, taken } = state(() => new Promise((resolve) => (answer = resolve)))
    const followed = followRustState(s)
    await settle()
    tauri.emit(s.event, 'S2')
    answer('S1')
    await followed
    expect(taken).toEqual(['S2', 'S1'])
  })
})
