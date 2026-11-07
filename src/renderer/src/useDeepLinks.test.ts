// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDeepLinks, type DeepLink } from './deepLink'
import { renderHook, settle, unmountAll } from '../../../tests/support/render-hook'
import { mockTauri } from '../../../tests/support/tauri-events'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', false))

const LINKED = '01890a5d-ac96-774b-bcce-b302099a8057'
const LATER = '01890a5d-ac96-774b-bcce-b302099a8058'

let tauri: ReturnType<typeof mockTauri>
afterEach(() => {
  unmountAll()
  tauri.clear()
})

describe('useDeepLinks', () => {
  it('runs the link a launch came with only once the window has restored its last note', async () => {
    tauri = mockTauri((cmd) => (cmd === 'deep_link_take' ? [{ kind: 'note', id: LINKED }] : null))
    const run = vi.fn<(link: DeepLink) => void>()
    const hook = renderHook(({ ready }: { ready: boolean }) => useDeepLinks(ready, run), {
      props: { ready: false },
    })
    await vi.waitFor(() => expect(tauri.invoked).toContain('deep_link_take'))
    await settle()
    tauri.emit('devot://open-url', { kind: 'note', id: LATER })
    await settle()
    expect(run).not.toHaveBeenCalled()

    hook.rerender({ ready: true })
    await settle()
    expect(run.mock.calls.map(([link]) => link)).toStrictEqual([{ kind: 'note', id: LINKED }])
    hook.rerender({ ready: true })
    await settle()
    expect(run.mock.calls.map(([link]) => link)).toStrictEqual([
      { kind: 'note', id: LINKED },
      { kind: 'note', id: LATER },
    ])
  })

  it('asks for the links that wait only once it listens for new ones', async () => {
    tauri = mockTauri((cmd) => (cmd === 'deep_link_take' ? [] : null))
    tauri.hold()
    renderHook(() => useDeepLinks(false, () => {}), { props: undefined })
    await vi.waitFor(() => expect(tauri.asked('devot://open-url')).toBe(1))
    await settle()
    expect(tauri.invoked).not.toContain('deep_link_take')
    tauri.release()
    await vi.waitFor(() => expect(tauri.invoked).toContain('deep_link_take'))
    expect(tauri.listening('devot://open-url')).toBe(1)
  })

  it('unmounted before it listens, stops the listener once made and asks for nothing', async () => {
    tauri = mockTauri((cmd) => (cmd === 'deep_link_take' ? [] : null))
    tauri.hold()
    const hook = renderHook(() => useDeepLinks(false, () => {}), { props: undefined })
    await vi.waitFor(() => expect(tauri.asked('devot://open-url')).toBe(1))
    hook.unmount()
    tauri.release()
    await settle()
    await settle()
    expect(tauri.listening('devot://open-url')).toBe(0)
    expect(tauri.invoked).not.toContain('deep_link_take')
  })
})
