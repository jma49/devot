// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Preview } from './Preview'
import type { Core } from '../core-client'

vi.mock('./PreviewBody', () => ({
  Preview: ({ markdown }: { markdown: string }) => <article>{markdown}</article>,
}))

it('loads the preview surface on demand and keeps forwarding note changes and empty bodies', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  const core = {} as Core
  const onOpenNote = vi.fn()
  try {
    await act(async () => {
      root.render(<Preview core={core} markdown="first" onOpenNote={onOpenNote} />)
      await vi.dynamicImportSettled()
    })
    expect(host.textContent).toBe('first')
    await act(async () => {
      root.render(<Preview core={core} markdown="" onOpenNote={onOpenNote} />)
    })
    expect(host.querySelector('article')?.textContent).toBe('')
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
