// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { copySelection } from './copySelection'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

it('offers HTML before plain text to rich paste targets', async () => {
  const order: string[] = []
  vi.stubGlobal(
    'ClipboardItem',
    class {
      constructor(private data: Record<string, Promise<Blob>>) {}
      get types(): string[] {
        return Object.keys(this.data)
      }
    },
  )
  vi.spyOn(navigator.clipboard, 'write').mockImplementation(async (items) => {
    order.push(...items[0]!.types)
  })
  const paragraph = document.createElement('p')
  paragraph.innerHTML = '<strong>Bold</strong> and <a href="https://example.com/">linked</a>'
  document.body.append(paragraph)
  const selection = window.getSelection()!
  selection.selectAllChildren(paragraph)
  await copySelection(Promise.resolve(selection))
  expect(order).toEqual(['text/html', 'text/plain'])
})

it.each(['empty', 'cancelled'])('does not write an %s selection', async (kind) => {
  vi.stubGlobal(
    'ClipboardItem',
    class {
      constructor(private data: Record<string, Promise<Blob>>) {}
      getType(type: string): Promise<Blob> {
        return this.data[type]!
      }
    },
  )
  const written: Blob[][] = []
  const write = vi.spyOn(navigator.clipboard, 'write').mockImplementation(async (items) => {
    const blobs = await Promise.all([
      items[0]!.getType('text/plain'),
      items[0]!.getType('text/html'),
    ])
    written.push(blobs)
  })
  const selection = kind === 'empty' ? window.getSelection() : null
  await expect(copySelection(Promise.resolve(selection))).rejects.toThrow(
    'E_PREVIEW_COPY_CANCELLED',
  )
  expect(write).toHaveBeenCalledOnce()
  expect(written).toEqual([])
})
