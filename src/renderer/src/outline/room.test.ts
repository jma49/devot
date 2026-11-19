import { describe, expect, it } from 'vitest'
import { inspectorRoom, scrollPreviewTo } from './room'
import type { ScrollPane } from '../preview/scrollSync'

describe('the outline column', () => {
  it('jumps synchronously when there is no pending full preview', () => {
    const pane = { element: { scrollTop: 0 }, offsetOf: () => 7000 } as unknown as ScrollPane
    scrollPreviewTo(pane, 900)
    expect(pane.element.scrollTop).toBe(7000)
  })

  it.each([true, false])(
    'waits for a tail heading, unless completion is cancelled: %s',
    async (ready) => {
      let finish!: (ready: boolean) => void
      const done = new Promise<boolean>((resolve) => {
        finish = resolve
      })
      let offset = 0
      const pane = {
        element: { scrollTop: 0 },
        offsetOf: () => offset,
        complete: () => done,
      } as unknown as ScrollPane
      scrollPreviewTo(pane, 900)
      offset = 7000
      finish(ready)
      await done
      expect(pane.element.scrollTop).toBe(ready ? 7000 : 0)
    },
  )

  it('needs the panes’ least width and its own', () => {
    expect(inspectorRoom(460, 'edit', 240)).toBe(220)
    expect(inspectorRoom(459, 'edit', 240)).toBe(219)
    expect(inspectorRoom(699, 'split', 240)).toBe(219)
    expect(inspectorRoom(700, 'split', 240)).toBe(220)
  })
})
