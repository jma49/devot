// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { PreviewFrame, PreviewFrameContent } from './PreviewFrame'

it('keeps a focusable pane in place while content loads and clears detached handlers', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const copied = vi.fn<() => void>()
  try {
    act(() => root.render(<PreviewFrame>{null}</PreviewFrame>))
    const pane = host.querySelector('article')!
    expect(pane.tabIndex).toBe(0)
    pane.focus()
    act(() =>
      root.render(
        <PreviewFrame>
          <PreviewFrameContent blocksEditable onCopy={copied}>
            <p>Loaded</p>
          </PreviewFrameContent>
        </PreviewFrame>,
      ),
    )
    expect(host.querySelector('article')).toBe(pane)
    expect(document.activeElement).toBe(pane)
    expect(pane.hasAttribute('data-blocks-editable')).toBe(true)
    pane.dispatchEvent(new Event('copy', { bubbles: true }))
    expect(copied).toHaveBeenCalledOnce()
    act(() => root.render(<PreviewFrame>{null}</PreviewFrame>))
    pane.dispatchEvent(new Event('copy', { bubbles: true }))
    expect(copied).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('applies editing affordances when its content mounts synchronously', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    act(() =>
      root.render(
        <PreviewFrame>
          <PreviewFrameContent blocksEditable />
        </PreviewFrame>,
      ),
    )
    expect(host.querySelector('article')!.hasAttribute('data-blocks-editable')).toBe(true)
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
