// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, settle, unmountAll } from '../../../../tests/support/render-hook'
import { restoreLocalStorage, useMemoryLocalStorage } from '../../../../tests/support/local-storage'
import { Inspector, useInspectorTab } from './Inspector'
import type { OutlinePanelProps } from './OutlinePanel'
import type { useOutlineRoom } from './useOutlineRoom'

vi.mock('./OutlinePanel', () => ({ OutlinePanel: () => <nav>outline tree</nav> }))

beforeEach(useMemoryLocalStorage)
afterEach(unmountAll)
afterAll(restoreLocalStorage)

const room = { width: 220, edge: { role: 'separator' }, fits: true } as unknown as ReturnType<
  typeof useOutlineRoom
>

let root: Root | undefined
let host: HTMLElement
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  host?.remove()
  document.dir = ''
})

function Harness(props: { info: () => void; history: () => void }) {
  const tab = useInspectorTab()
  return (
    <Inspector
      noteId="n"
      room={room}
      tab={tab}
      outline={{} as OutlinePanelProps}
      info={<Mounted onMount={props.info} label="info body" />}
      history={<Mounted onMount={props.history} label="history body" />}
    />
  )
}

function Mounted(props: { onMount: () => void; label: string }) {
  const { onMount } = props
  useEffect(() => onMount(), [onMount])
  return <p>{props.label}</p>
}

async function mount() {
  const info = vi.fn<() => void>()
  const history = vi.fn<() => void>()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(<Harness info={info} history={history} />))
  await settle()
  return { info, history }
}

const tab = (name: string) => host.querySelector<HTMLElement>(`#inspector-tab-${name}`)!
const key = (el: HTMLElement, k: string) =>
  act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))

describe('the inspector tabs', () => {
  it('give only the active tab the keyboard and label each panel by its tab', async () => {
    await mount()
    expect(tab('outline').tabIndex).toBe(0)
    expect(tab('info').tabIndex).toBe(-1)
    expect(tab('history').tabIndex).toBe(-1)
    const panel = host.querySelector('#inspector-panel-info')!
    expect(panel.getAttribute('role')).toBe('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe('inspector-tab-info')
    expect(host.querySelector('[role="separator"]')?.getAttribute('aria-label')).toBe(
      'Resize Inspector',
    )
    expect(host.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe(
      'Inspector Tabs',
    )
  })

  it('move with the arrow keys, wrapping, and jump with Home and End', async () => {
    await mount()
    key(tab('outline'), 'ArrowRight')
    expect(tab('info').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab('info'))
    key(tab('info'), 'End')
    expect(tab('history').getAttribute('aria-selected')).toBe('true')
    key(tab('history'), 'ArrowRight')
    expect(tab('outline').getAttribute('aria-selected')).toBe('true')
    key(tab('outline'), 'ArrowLeft')
    expect(tab('history').getAttribute('aria-selected')).toBe('true')
    key(tab('history'), 'Home')
    expect(tab('outline').getAttribute('aria-selected')).toBe('true')
  })

  it('reverse the arrow keys right to left', async () => {
    document.dir = 'rtl'
    await mount()
    key(tab('outline'), 'ArrowLeft')
    expect(tab('info').getAttribute('aria-selected')).toBe('true')
  })

  it('mount a panel the first time its tab shows and keep it after', async () => {
    const { info, history } = await mount()
    expect(host.textContent).toContain('outline tree')
    expect(info).not.toHaveBeenCalled()
    expect(history).not.toHaveBeenCalled()
    act(() => tab('info').click())
    expect(info).toHaveBeenCalled()
    act(() => tab('outline').click())
    expect(host.textContent).toContain('info body')
    expect(host.querySelector<HTMLElement>('#inspector-panel-info')!.hidden).toBe(true)
    expect(history).not.toHaveBeenCalled()
  })

  const mountFor = (noteId: string, shown: ReturnType<typeof useInspectorTab>) => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() =>
      root!.render(
        <Inspector
          noteId={noteId}
          room={room}
          tab={shown}
          outline={{} as OutlinePanelProps}
          history={<p>history body</p>}
        />,
      ),
    )
  }

  it('focus the tab a command shows once the inspector has mounted it for that note', () => {
    const hook = renderHook(() => useInspectorTab(), { props: {} })
    act(() => hook.current.show('history', 'n'))
    expect(hook.current.focusFor).toBe('n')
    mountFor('n', hook.current)
    expect(document.activeElement).toBe(tab('history'))
    expect(hook.current.focusFor).toBeUndefined()
  })

  it('never take the keyboard for a request made without a note or for another note', () => {
    const outside = document.createElement('input')
    document.body.append(outside)
    const hook = renderHook(() => useInspectorTab(), { props: {} })
    act(() => hook.current.show('outline'))
    expect(hook.current.focusFor).toBeUndefined()
    act(() => hook.current.show('history', 'a'))
    outside.focus()
    mountFor('b', hook.current)
    expect(document.activeElement).toBe(outside)
    expect(hook.current.focusFor).toBeUndefined()
    outside.remove()
  })

  it('drop a request the inspector never mounted for', () => {
    const hook = renderHook(() => useInspectorTab(), { props: {} })
    act(() => hook.current.show('info', 'n'))
    act(() => hook.current.dropFocus())
    expect(hook.current.focusFor).toBeUndefined()
  })
})

describe('the Info toggle', () => {
  it('shows Info, then goes back to the tab before it', () => {
    const hook = renderHook(() => useInspectorTab(), { props: {} })
    act(() => hook.current.select('history'))
    act(() => hook.current.toggleInfo('n'))
    expect(hook.current.active).toBe('info')
    expect(hook.current.focusFor).toBe('n')
    act(() => hook.current.toggleInfo('n'))
    expect(hook.current.active).toBe('history')
  })
})
