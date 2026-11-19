// @vitest-environment happy-dom
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { popupBox } from './theme'

const boxAt = (el: Element, left: number, top: number, right: number, bottom: number) => {
  el.getBoundingClientRect = () =>
    ({
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
      x: left,
      y: top,
    }) as DOMRect
}

let view: EditorView | undefined
afterEach(() => {
  view?.destroy()
  view = undefined
  document.body.replaceChildren()
})

/** pane > toolbar + scroller > host (the editor), each box placed by hand. */
function layout(scroller: { left: number; right: number; overflowX: string }) {
  const pane = document.createElement('div')
  pane.dataset.devotPart = 'editor'
  const toolbar = document.createElement('div')
  toolbar.dataset.devotPart = 'toolbar'
  const clip = document.createElement('div')
  clip.style.overflowX = scroller.overflowX
  clip.style.overflowY = 'visible'
  const host = document.createElement('div')
  host.style.overflowX = 'visible'
  host.style.overflowY = 'visible'
  clip.append(host)
  pane.append(toolbar, clip)
  document.body.append(pane)
  view = new EditorView({ parent: host })
  boxAt(toolbar, 0, 0, 1000, 40)
  boxAt(clip, scroller.left, 40, scroller.right, 800)
  boxAt(host, 100, 60, 700, 800)
  boxAt(view.dom, 100, 60, 700, 800)
  return view
}

describe('popupBox', () => {
  it('is the editor itself when nothing around it clips sideways', () => {
    const box = popupBox(layout({ left: 0, right: 1000, overflowX: 'visible' }))
    expect(box).toMatchObject({ left: 100, right: 700, bottom: 800 })
  })

  it('cuts the editor to a sideways scroller narrower than it', () => {
    const box = popupBox(layout({ left: 250, right: 500, overflowX: 'auto' }))
    expect(box).toMatchObject({ left: 250, right: 500 })
  })

  it('never has its right edge before its left, for an editor scrolled out of sight', () => {
    const box = popupBox(layout({ left: 800, right: 900, overflowX: 'auto' }))
    expect(box.left).toBe(800)
    expect(box.right).toBe(800)
  })

  it('reaches up to the toolbar, above the editor, while nothing clips it vertically', () => {
    const box = popupBox(layout({ left: 0, right: 1000, overflowX: 'visible' }))
    expect(box.top).toBe(40)
  })
})
