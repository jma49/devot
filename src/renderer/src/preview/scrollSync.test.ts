import { describe, expect, it } from 'vitest'
import { lineAt, normalizeAnchors, syncScrolling, topOf, type ScrollPane } from './scrollSync'

describe('anchors', () => {
  const anchors = normalizeAnchors(
    [
      { line: 3, top: 100 },
      { line: 3, top: 120 }, // a list and its first item: same line
      { line: 10, top: 400 },
      { line: 8, top: 450 }, // out of order (a footnote): dropped
      { line: 20, top: 900 },
    ],
    { line: 31, top: 1500 },
  )

  it('start at the top, end at the bottom, and only ever go down in both', () => {
    expect(anchors).toEqual([
      { line: 1, top: 0 },
      { line: 3, top: 100 },
      { line: 10, top: 400 },
      { line: 20, top: 900 },
      { line: 31, top: 1500 },
    ])
    expect(normalizeAnchors([], { line: 5, top: 200 })).toEqual([
      { line: 1, top: 0 },
      { line: 5, top: 200 },
    ])
  })

  it('map a line to an offset and back, between anchors too', () => {
    expect(topOf(anchors, 3)).toBe(100)
    expect(topOf(anchors, 6.5)).toBe(250)
    expect(lineAt(anchors, 250)).toBe(6.5)
    expect(lineAt(anchors, 900)).toBe(20)
    for (const line of [1, 2.25, 9.9, 15, 30])
      expect(lineAt(anchors, topOf(anchors, line))).toBeCloseTo(line)
  })

  it('clamp outside the content', () => {
    expect(topOf(anchors, 0)).toBe(0)
    expect(topOf(anchors, 99)).toBe(1500)
    expect(lineAt(anchors, -10)).toBe(1)
    expect(lineAt(anchors, 9999)).toBe(31)
  })

  it('keep the first of two anchors at the same offset', () => {
    const same = normalizeAnchors(
      [
        { line: 2, top: 50 },
        { line: 4, top: 50 },
      ],
      { line: 9, top: 300 },
    )
    expect(same).toEqual([
      { line: 1, top: 0 },
      { line: 2, top: 50 },
      { line: 9, top: 300 },
    ])
    expect(lineAt(same, 50)).toBe(2)
  })
})

/** A pane over a fake scroller: one pixel per line, `height` pixels tall. */
class FakePane implements ScrollPane {
  readonly element = Object.assign(new EventTarget(), {
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 100,
  })
  scrolledTo: number[] = []
  private layout = new Set<() => void>()
  constructor(private readonly scale = 1) {}
  topLine() {
    return this.element.scrollTop / this.scale + 1
  }
  offsetOf(line: number) {
    this.scrolledTo.push(line)
    return (line - 1) * this.scale
  }
  onLayout(listener: () => void) {
    this.layout.add(listener)
    return () => this.layout.delete(listener)
  }
  /** Sets the offset as the browser clamps it, without a scroll event. */
  set(top: number) {
    const max = this.element.scrollHeight - this.element.clientHeight
    this.element.scrollTop = Math.max(0, Math.min(max, top))
  }
  /** The browser's scroll event for the current offset. */
  fire() {
    this.element.dispatchEvent(new Event('scroll'))
  }
  /** The user scrolls to `top`. */
  userScroll(top: number) {
    this.set(top)
    this.fire()
  }
  relayout() {
    for (const listener of this.layout) listener()
  }
  gesture(type = 'wheel') {
    this.element.dispatchEvent(new Event(type))
  }
}

function setup({ lead = 'first' as 'first' | 'second', previewHeight = 1000 } = {}) {
  const frames: (() => void)[] = []
  let time = 0
  const editor = new FakePane(1)
  const preview = new FakePane(2)
  preview.element.scrollHeight = previewHeight
  const stop = syncScrolling(editor, preview, {
    lead,
    frame: (run) => frames.push(run),
    cancel: () => frames.splice(0),
    now: () => time,
  })
  const flush = () => frames.splice(0).forEach((run) => run())
  const wait = (ms: number) => (time += ms)
  return { editor, preview, stop, flush, wait, frames }
}

describe('syncScrolling', () => {
  it("starts with the preview at the editor's line", () => {
    const { editor, preview, flush } = setup()
    editor.set(40)
    flush()
    expect(preview.scrolledTo).toEqual([41])
    expect(preview.element.scrollTop).toBe(80)
  })

  it('moves the other pane once per frame, to the matching line', () => {
    const { editor, preview, flush } = setup()
    flush()
    editor.userScroll(10)
    editor.userScroll(20)
    expect(preview.scrolledTo).toEqual([])
    flush()
    expect(preview.scrolledTo).toEqual([21])
    expect(preview.element.scrollTop).toBe(40)

    preview.userScroll(300)
    flush()
    expect(editor.element.scrollTop).toBe(150)
  })

  it('never echoes its own scroll back', () => {
    const { editor, preview, flush } = setup()
    flush()
    editor.userScroll(30)
    flush()
    // The preview's scroll event for the offset set above.
    preview.fire()
    flush()
    expect(editor.scrolledTo).toEqual([])
    expect(editor.element.scrollTop).toBe(30)
  })

  it("takes a later scroll of the follower as the user's", () => {
    const { editor, preview, flush } = setup()
    flush()
    editor.userScroll(30)
    flush()
    preview.userScroll(500)
    flush()
    expect(editor.scrolledTo).toEqual([251])
  })

  it('lines up the ends: top with top, bottom with bottom', () => {
    const { editor, preview, flush } = setup()
    flush()
    editor.userScroll(900)
    flush()
    expect(preview.element.scrollTop).toBe(900)
    preview.userScroll(0)
    flush()
    expect(editor.element.scrollTop).toBe(0)
  })

  it('ignores the pane the user left while they scroll the other one', () => {
    const { editor, preview, flush, wait } = setup()
    flush()
    preview.gesture('wheel')
    preview.userScroll(200)
    flush()
    // Momentum from an earlier flick of the editor, right after.
    wait(100)
    editor.userScroll(500)
    flush()
    expect(preview.element.scrollTop).toBe(200)
    // Later, scrolling the editor counts again.
    wait(1000)
    editor.userScroll(50)
    flush()
    expect(preview.element.scrollTop).toBe(100)
  })

  it('takes no click or key as a scroll gesture', () => {
    const { editor, preview, flush } = setup()
    flush()
    preview.gesture('pointerdown')
    preview.gesture('keydown')
    // Find scrolls the editor right after a click in the preview.
    editor.userScroll(40)
    flush()
    expect(preview.element.scrollTop).toBe(80)
  })

  it('lines up a pane again after it is laid out anew', () => {
    const { editor, preview, flush } = setup()
    flush()
    editor.userScroll(30)
    flush()
    preview.set(0)
    preview.relayout()
    flush()
    expect(preview.element.scrollTop).toBe(60)
    expect(editor.scrolledTo).toEqual([])
  })

  it('takes the scroll a pane is clamped to while laid out anew for no lead', () => {
    const { editor, preview, flush } = setup()
    flush()
    editor.userScroll(30)
    flush()
    // The preview got shorter: the browser clamps its offset and reports it.
    preview.relayout()
    preview.userScroll(20)
    flush()
    expect(editor.element.scrollTop).toBe(30)
    expect(preview.element.scrollTop).toBe(60)
  })

  it('blends into the end over the last screen, without a jump', () => {
    const { editor, preview, flush } = setup({ previewHeight: 3000 })
    flush()
    // Above the editor's last screen (offsets 800 to 900): the matching line.
    editor.userScroll(790)
    flush()
    expect(preview.element.scrollTop).toBe(1580)
    // Halfway through it: halfway from the matching line to the preview's end.
    editor.userScroll(850)
    flush()
    expect(preview.element.scrollTop).toBe(1700 + (2900 - 1700) / 2)
    editor.userScroll(900)
    flush()
    expect(preview.element.scrollTop).toBe(2900)
  })

  it('starts from the preview when it was being read', () => {
    const { editor, preview, flush } = setup({ lead: 'second' })
    preview.set(300)
    flush()
    expect(editor.element.scrollTop).toBe(150)
    expect(preview.element.scrollTop).toBe(300)
  })

  it('leaves a pane laid out anew where it is while the user works in it', () => {
    const { editor, preview, flush } = setup()
    flush()
    preview.userScroll(400)
    flush()
    expect(editor.element.scrollTop).toBe(200)
    // An image above loads: the preview keeps the offset the user scrolled to.
    preview.set(380)
    preview.relayout()
    flush()
    expect(preview.element.scrollTop).toBe(380)
    // Back to typing in the editor: the next rendering lines the preview up.
    editor.gesture('keydown')
    preview.relayout()
    flush()
    expect(preview.element.scrollTop).toBe(400)
  })

  it('takes no lead from a pane that cannot scroll', () => {
    const { editor, preview, flush } = setup()
    editor.element.scrollHeight = 100
    flush()
    preview.userScroll(300)
    flush()
    expect(editor.element.scrollTop).toBe(0)
    // Typing in the short note re-renders the preview: it stays where it was read.
    editor.gesture('keydown')
    preview.relayout()
    flush()
    expect(preview.element.scrollTop).toBe(300)
  })

  it('stops listening when stopped', () => {
    const { editor, preview, stop, flush, frames } = setup()
    editor.userScroll(30)
    stop()
    expect(frames).toEqual([])
    editor.userScroll(60)
    preview.relayout()
    flush()
    expect(preview.scrolledTo).toEqual([])
  })
})
