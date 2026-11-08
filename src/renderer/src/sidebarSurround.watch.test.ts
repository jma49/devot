// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { startSidebarSurround } from './sidebarSurround'

const frame = () => new Promise((done) => requestAnimationFrame(() => done(undefined)))

describe('startSidebarSurround', () => {
  it('measures the sidebar again when the window changes, not when the note renders', async () => {
    document.body.innerHTML =
      '<div class="window"><nav class="sidebar"></nav><article data-devot-part="preview"><div class="preview-body"></div></article></div>'
    const sidebar = document.querySelector('.sidebar')!
    const box = vi
      .spyOn(sidebar, 'getBoundingClientRect')
      .mockReturnValue({ left: 8, top: 8, width: 200, height: 600 } as DOMRect)
    const sheet = document.querySelector<HTMLElement>('.window')!
    const write = vi.spyOn(sheet.style, 'setProperty')
    startSidebarSurround(document)
    await frame()
    await frame()
    expect(box).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledTimes(1)

    const content = document.querySelector('.preview-body')!
    for (let i = 0; i < 20; i += 1) content.append(document.createElement('p'))
    content.firstElementChild!.append(document.createElement('em'))
    await frame()
    await frame()
    expect(box).toHaveBeenCalledTimes(1)

    // Measured again, to the same place: nothing written.
    document.querySelector('.window')!.append(document.createElement('div'))
    await frame()
    await frame()
    expect(box).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenCalledTimes(1)

    document.querySelector('.window')!.setAttribute('data-focus', '')
    await frame()
    await frame()
    expect(box).toHaveBeenCalledTimes(3)
    expect(sheet.style.getPropertyValue('--sidebar-surround-clip')).toBe('')
  })

  it('writes the cutout on the sheet, never on the root, so no block of the note inherits it', async () => {
    document.body.innerHTML = '<div class="window"><nav class="sidebar"></nav></div>'
    vi.spyOn(document.querySelector('.sidebar')!, 'getBoundingClientRect').mockReturnValue({
      left: 8,
      top: 8,
      width: 200,
      height: 600,
    } as DOMRect)
    startSidebarSurround(document)
    await frame()
    await frame()
    const first = document.querySelector<HTMLElement>('.window')!
    const clip = first.style.getPropertyValue('--sidebar-surround-clip')
    expect(clip).toMatch(/^path\(/)
    expect(document.documentElement.style.getPropertyValue('--sidebar-surround-clip')).toBe('')

    // A new sheet for the same place gets the cutout too.
    const next = document.createElement('div')
    next.className = 'window'
    next.innerHTML = '<nav class="sidebar"></nav>'
    vi.spyOn(next.querySelector('.sidebar')!, 'getBoundingClientRect').mockReturnValue({
      left: 8,
      top: 8,
      width: 200,
      height: 600,
    } as DOMRect)
    first.replaceWith(next)
    await frame()
    await frame()
    expect(next.style.getPropertyValue('--sidebar-surround-clip')).toBe(clip)
    expect(document.documentElement.style.getPropertyValue('--sidebar-surround-clip')).toBe('')
  })
})
