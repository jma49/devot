// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useModeSwitch } from './useMode'
import type { Mode } from '../ModeControl'
import type { EditorHandle } from '../editor/handle'

vi.mock('../commands/dispatch', () => ({
  inEditor: (el: Element) => el.matches('textarea'),
  useMenuEvent: () => {},
}))
vi.mock('../paneMotion', () => ({ measureModePanes: () => ({}), playModeChange: () => {} }))

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

it.each([false, true])(
  'keeps lazy preview focus pending, unless the mode changes back (%s)',
  async (cancel) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const host = document.createElement('main')
    document.body.append(host)
    const root = createRoot(host)
    const pressToggle = () => {
      host
        .querySelector('textarea')!
        .dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'e', metaKey: true }))
    }
    function App() {
      const [mode, setMode] = useState<Mode>('edit')
      const editorMode = useRef<Mode>('edit')
      const editorRef = useRef<EditorHandle | null>(null)
      const toggle = useModeSwitch({ mode, setMode, editorMode, editorRef })
      return <textarea aria-label="Editor" onKeyDown={toggle} />
    }
    try {
      act(() => root.render(<App />))
      host.querySelector('textarea')!.focus()
      act(pressToggle)
      if (cancel) act(pressToggle)
      const pane = document.createElement('section')
      pane.className = 'preview'
      pane.tabIndex = 0
      await act(async () => host.append(pane))
      expect(document.activeElement === pane).toBe(!cancel)
    } finally {
      act(() => root.unmount())
    }
  },
)
