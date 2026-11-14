// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPrefills, usePrefills, withPrefill, type Prefill } from './prefill'
import { renderHook, settle, unmountAll } from '../../../../tests/support/render-hook'
import { mockTauri } from '../../../../tests/support/tauri-events'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', false))

const EVENT = 'devot://quick-capture-prefill'
const TAKE = 'quick_capture_prefill_take'

describe('withPrefill', () => {
  it('fills an empty window with the link text', () => {
    expect(withPrefill({ title: '', body: '' }, { title: 'Page', body: 'quote' })).toEqual({
      title: 'Page',
      body: 'quote',
    })
  })

  it('keeps what is typed and adds the link text after it', () => {
    expect(
      withPrefill({ title: 'Mine', body: 'typed\n\n' }, { title: 'Page', body: 'quote' }),
    ).toEqual({ title: 'Mine', body: 'typed\n\nPage\nquote' })
    expect(withPrefill({ title: 'Mine', body: '' }, { title: 'Mine', body: 'quote' })).toEqual({
      title: 'Mine',
      body: 'quote',
    })
    expect(withPrefill({ title: ' ', body: 'typed' }, { title: 'Page', body: '' })).toEqual({
      title: 'Page',
      body: 'typed',
    })
  })
})

describe('readPrefills', () => {
  it('takes only well-formed captures', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readPrefills(null)).toEqual([])
    expect(
      readPrefills([{ title: 'a', body: 'b', extra: 1 }, { title: 1, body: '' }, 'x']),
    ).toEqual([{ title: 'a', body: 'b' }])
    expect(console.warn).toHaveBeenCalledWith('W_CAPTURE_LINK_INVALID')
  })
})

let tauri: ReturnType<typeof mockTauri> | undefined
afterEach(() => {
  unmountAll()
  tauri?.clear()
  tauri = undefined
  vi.restoreAllMocks()
})

function waiting(...batches: Prefill[][]) {
  return (cmd: string) => (cmd === TAKE ? (batches.shift() ?? []) : null)
}

describe('usePrefills', () => {
  it('asks for what waits only once it listens, then takes each link as it comes', async () => {
    const one = { title: 'one', body: '' }
    const two = { title: 'two', body: '' }
    const ipc = mockTauri(waiting([one], [two]))
    tauri = ipc
    ipc.hold()
    const apply = vi.fn<(prefills: Prefill[]) => void>()
    renderHook(() => usePrefills(apply, false), { props: undefined })
    await vi.waitFor(() => expect(ipc.asked(EVENT)).toBe(1))
    await settle()
    expect(ipc.invoked).not.toContain(TAKE)
    ipc.release()
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith([one]))
    ipc.emit(EVENT)
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith([two]))
  })

  it('takes nothing while a save is on its way, and takes what came once it ends', async () => {
    const later = { title: 'later', body: '' }
    const ipc = mockTauri(waiting([], [later]))
    tauri = ipc
    const apply = vi.fn<(prefills: Prefill[]) => void>()
    const hook = renderHook(({ paused }: { paused: boolean }) => usePrefills(apply, paused), {
      props: { paused: false },
    })
    await vi.waitFor(() => expect(ipc.invoked.filter((c) => c === TAKE)).toHaveLength(1))
    hook.rerender({ paused: true })
    await settle()
    ipc.emit(EVENT)
    await settle()
    expect(ipc.invoked.filter((c) => c === TAKE)).toHaveLength(1)
    hook.rerender({ paused: false })
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith([later]))
  })

  it('unmounted, applies nothing that arrives after', async () => {
    const ipc = mockTauri(waiting([{ title: 'late', body: '' }]))
    tauri = ipc
    ipc.hold()
    const apply = vi.fn<(prefills: Prefill[]) => void>()
    const hook = renderHook(() => usePrefills(apply, false), { props: undefined })
    await vi.waitFor(() => expect(ipc.asked(EVENT)).toBe(1))
    hook.unmount()
    ipc.release()
    await settle()
    expect(ipc.invoked).not.toContain(TAKE)
    expect(apply).not.toHaveBeenCalled()
  })
})
