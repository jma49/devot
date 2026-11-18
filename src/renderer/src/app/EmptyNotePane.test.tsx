// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { EmptyNotePane } from './EmptyNotePane'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../icons/Icon', () => ({
  Icon: ({ name, size }: { name: string; size?: string }) => (
    <span data-mock-icon={name} data-mock-size={size} />
  ),
}))

async function renderPane(editing: boolean) {
  const handlers = {
    onNewNote: vi.fn<() => void>(),
    onOpenToday: vi.fn<() => void>(),
    onOpenPalette: vi.fn<() => void>(),
    onNewFromTemplate: vi.fn<() => void>(),
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<EmptyNotePane editing={editing} {...handlers} />)
  })
  return {
    host,
    handlers,
    unmount: async () => {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

describe('EmptyNotePane', () => {
  it('renders all shortcut-labelled actions with small icons and distinct accessible names', async () => {
    const view = await renderPane(true)
    try {
      const region = view.host.querySelector('section.empty-pane')
      expect(region?.getAttribute('aria-label')).toBe('Quick Actions')
      const buttons = [...view.host.querySelectorAll('button.empty-pane-action')]
      expect(buttons).toHaveLength(4)
      expect(buttons.map((b) => b.textContent)).toEqual([
        'New Note⌘N',
        'Open Today’s Note⌥⌘T',
        'Command Palette⌘K',
        'New Note from Template…⌘T',
      ])
      // Every launcher icon stays at `sm` (11 pt) so toolbar SF Symbol caches at `@14` stay singletons.
      for (const icon of view.host.querySelectorAll('[data-mock-icon]')) {
        expect(icon.getAttribute('data-mock-size')).toBe('sm')
      }
      for (const b of buttons) (b as HTMLButtonElement).click()
      expect(view.handlers.onNewNote).toHaveBeenCalledTimes(1)
      expect(view.handlers.onOpenToday).toHaveBeenCalledTimes(1)
      expect(view.handlers.onOpenPalette).toHaveBeenCalledTimes(1)
      expect(view.handlers.onNewFromTemplate).toHaveBeenCalledTimes(1)
    } finally {
      await view.unmount()
    }
  })

  it('uses aria-disabled for note-creating actions when editing is locked', async () => {
    const view = await renderPane(false)
    try {
      const buttons = [
        ...view.host.querySelectorAll('button.empty-pane-action'),
      ] as HTMLButtonElement[]
      expect(buttons[0]?.getAttribute('aria-disabled')).toBe('true')
      expect(buttons[0]?.disabled).toBe(false)
      expect(buttons[1]?.getAttribute('aria-disabled')).toBeNull()
      expect(buttons[2]?.getAttribute('aria-disabled')).toBeNull()
      expect(buttons[3]?.getAttribute('aria-disabled')).toBe('true')
      expect(buttons[3]?.disabled).toBe(false)

      for (const b of buttons) b.click()
      expect(view.handlers.onNewNote).not.toHaveBeenCalled()
      expect(view.handlers.onNewFromTemplate).not.toHaveBeenCalled()
      expect(view.handlers.onOpenToday).toHaveBeenCalledTimes(1)
      expect(view.handlers.onOpenPalette).toHaveBeenCalledTimes(1)
    } finally {
      await view.unmount()
    }
  })
})
