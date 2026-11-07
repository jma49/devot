import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  lineAt,
  normalizeAnchors,
  previewScrollPane,
  shiftScroll,
  syncScrolling,
  topOf,
  wheelDistance,
  type ScrollPane,
} from './scrollSync'

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

describe('anchors over blank lines and long blocks', () => {
  // Line 1 a heading, lines 2-4 blank, a paragraph at 5, a 50-line code
  // block from 8 to 59, then a paragraph at 61; the note has 61 lines.
  const anchors = normalizeAnchors(
    [
      { line: 1, top: 0 },
      { line: 5, top: 60 },
      { line: 8, top: 120 },
      { line: 61, top: 1120 },
    ],
    { line: 62, top: 1150 },
  )

  it('move evenly through blank lines', () => {
    expect(topOf(anchors, 3)).toBe(30)
    expect(lineAt(anchors, 45)).toBe(4)
  })

  it('move evenly through a long code block, which has one anchor', () => {
    expect(topOf(anchors, 34.5)).toBe(620)
    expect(lineAt(anchors, 620)).toBe(34.5)
    let previous = -1
    for (let line = 8; line <= 61; line += 0.5) {
      const top = topOf(anchors, line)
      expect(top).toBeGreaterThan(previous)
      previous = top
    }
  })

  it('reach both ends exactly', () => {
    expect(topOf(anchors, 1)).toBe(0)
    expect(lineAt(anchors, 0)).toBe(1)
    expect(topOf(anchors, 62)).toBe(1150)
    expect(lineAt(anchors, 1150)).toBe(62)
  })

  it('make do with no blocks at all (an empty note)', () => {
    const empty = normalizeAnchors([], { line: 2, top: 0 })
    expect(empty).toEqual([{ line: 1, top: 0 }])
    expect(topOf(empty, 5)).toBe(0)
    expect(lineAt(empty, 40)).toBe(1)
  })
})

describe('wheelDistance', () => {
  const wheel = (deltaY: number, more: object = {}) => ({
    deltaX: 0,
    deltaY,
    deltaMode: 0,
    ...more,
  })

  it('counts pixels, lines and pages', () => {
    expect(wheelDistance(wheel(12.5), 600)).toBe(12.5)
    expect(wheelDistance(wheel(-3, { deltaMode: 1 }), 600)).toBe(-120)
    expect(wheelDistance(wheel(1, { deltaMode: 2 }), 600)).toBe(600)
  })

  it('leaves sideways scrolls and pinches alone', () => {
    expect(wheelDistance(wheel(2, { deltaX: 5 }), 600)).toBeNull()
    expect(wheelDistance(wheel(4, { ctrlKey: true }), 600)).toBeNull()
    expect(wheelDistance(wheel(0), 600)).toBeNull()
  })
})

interface FakeBlock {
  line: number
  top: number
}

/**
 * A preview made of pieces, each a run of blocks with a source line and an
 * offset in the content. Its pane stays where it is on screen, so a block's
 * box moves up as the pane scrolls. It counts the boxes read.
 */
function fakePreview(pieces: FakeBlock[][], height: number) {
  const counter = { reads: 0 }
  const element = Object.assign(new EventTarget(), {
    scrollTop: 0,
    scrollHeight: height,
    clientHeight: 100,
    clientTop: 0,
    getBoundingClientRect: () => ({ top: 0 }),
  })
  const runOf = (blocks: FakeBlock[]) => ({
    line: blocks[0]?.line ?? 1,
    marked: blocks.map((block) => ({
      getAttribute: (name: string) => (name === 'data-source-line' ? String(block.line) : null),
      getBoundingClientRect: () => {
        counter.reads += 1
        return { top: block.top - element.scrollTop }
      },
    })) as unknown as Element[],
  })
  return {
    element,
    scroller: element as unknown as HTMLElement,
    counter,
    runOf,
    runs: pieces.map(runOf),
  }
}

/** Where every block measured in one pass puts a line and an offset (the reference). */
function measuredAll(pieces: FakeBlock[][], lines: number, height: number) {
  return normalizeAnchors(pieces.flat(), { line: lines + 1, top: height })
}

/** A big note: a heading, a paragraph and a list with a nested item in each of `count` sections. */
function bigNote(count: number) {
  const pieces: FakeBlock[][] = []
  for (let i = 0; i < count; i += 1) {
    const line = i * 8 + 1
    const top = i * 200
    pieces.push([{ line, top }])
    pieces.push([{ line: line + 2, top: top + 40 }])
    pieces.push([
      { line: line + 4, top: top + 100 },
      { line: line + 4, top: top + 100 },
      { line: line + 5, top: top + 130 },
    ])
  }
  return { pieces, lines: count * 8, height: count * 200 }
}

/** The node test environment has no ResizeObserver; the preview only starts one. */
const stubResizeObserver = () =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )

function frameQueue() {
  const queued: (() => void)[] = []
  return {
    frame: (run: () => void) => queued.push(run),
    cancel: () => void queued.splice(0),
    flush: () => queued.splice(0).forEach((run) => run()),
  }
}

describe('previewScrollPane', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('measures its blocks again when an image above loads late, once a frame', () => {
    stubResizeObserver()
    // An image paragraph at line 3, then a heading at line 5; 9 lines.
    const pieces = [[{ line: 1, top: 0 }], [{ line: 3, top: 40 }], [{ line: 5, top: 60 }]]
    const preview = fakePreview(pieces, 200)
    const frame = frameQueue()
    const pane = previewScrollPane(preview.scroller, frame)
    pane.rendered(9, preview.runs)
    let laidOut = 0
    pane.onLayout!(() => laidOut++)
    expect(pane.offsetOf(5)).toBe(60)
    // The image loads at 300 pixels: everything below moves down.
    pieces[2]![0]!.top = 360
    preview.element.scrollHeight = 500
    preview.element.dispatchEvent(new Event('load'))
    preview.element.dispatchEvent(new Event('load'))
    expect(laidOut).toBe(0)
    frame.flush()
    expect(laidOut).toBe(1)
    expect(pane.offsetOf(5)).toBe(360)
    expect(pane.offsetOf(4)).toBe(200)
    pane.dispose()
  })

  it('is moved by a distance through itself, and says so unless nothing moved', () => {
    stubResizeObserver()
    const { scroller, element } = fakePreview([[{ line: 1, top: 0 }]], 1000)
    const pane = previewScrollPane(scroller)
    let moved = 0
    pane.onMove!(() => moved++)
    shiftScroll(scroller, 120)
    expect(element.scrollTop).toBe(120)
    expect(moved).toBe(1)
    shiftScroll(scroller, 0)
    expect(moved).toBe(1)
    pane.dispose()
    shiftScroll(scroller, 30)
    expect(element.scrollTop).toBe(150)
    expect(moved).toBe(1)
  })

  it('reads only the blocks around the place asked for in a big note', () => {
    stubResizeObserver()
    const note = bigNote(20_000)
    const preview = fakePreview(note.pieces, note.height)
    const pane = previewScrollPane(preview.scroller)
    pane.rendered(note.lines, preview.runs)
    const all = measuredAll(note.pieces, note.lines, note.height)
    expect(pane.offsetOf(80_003)).toBe(topOf(all, 80_003))
    preview.element.scrollTop = 2_000_150
    expect(pane.topLine()).toBe(lineAt(all, 2_000_150))
    expect(preview.counter.reads).toBeLessThan(60)
    pane.dispose()
  })

  it('after an edit that adds a line, reads again only the blocks it needs', () => {
    stubResizeObserver()
    const note = bigNote(20_000)
    const preview = fakePreview(note.pieces, note.height)
    const pane = previewScrollPane(preview.scroller)
    pane.rendered(note.lines, preview.runs)
    expect(pane.offsetOf(80_003)).toBe(
      topOf(measuredAll(note.pieces, note.lines, note.height), 80_003),
    )
    // Enter in the paragraph of section 10 000: it gets a line and 30 pixels, and so does all below.
    const edited = 30_001
    const pieces = note.pieces.map((blocks, at) =>
      at < edited ? blocks : blocks.map((block) => ({ ...block })),
    )
    for (const [at, blocks] of pieces.entries()) {
      if (at <= edited) continue
      for (const block of blocks) {
        block.line += 1
        block.top += 30
      }
      note.pieces[at]!.forEach((block, k) => Object.assign(block, blocks[k]))
    }
    const runs = preview.runs.map((run, at) =>
      at === edited
        ? preview.runOf(pieces[at]!)
        : Object.assign(run, { line: pieces[at]![0]!.line }),
    )
    preview.element.scrollHeight += 30
    preview.counter.reads = 0
    pane.rendered(note.lines + 1, runs)
    const all = measuredAll(pieces, note.lines + 1, note.height + 30)
    for (const line of [80_002, 80_003, 80_004, 80_010.5])
      expect(pane.offsetOf(line)).toBe(topOf(all, line))
    expect(preview.counter.reads).toBeLessThan(30)
    // The preview then scrolls to that line: what was just measured tells where it is.
    const reads = preview.counter.reads
    preview.element.scrollTop = pane.offsetOf(80_003)
    expect(pane.topLine()).toBe(lineAt(all, preview.element.scrollTop))
    expect(preview.counter.reads).toBe(reads)
    pane.dispose()
  })

  it('maps every line and offset as measuring every block does', () => {
    stubResizeObserver()
    // Blank lines above the first block, a list on its first item's line, a block at the
    // offset of the one before, a piece that shows nothing, a long code block and the
    // footnotes at the end, some defined above and some below the last block.
    const pieces: FakeBlock[][] = [
      [{ line: 3, top: 0 }],
      [
        { line: 5, top: 30 },
        { line: 5, top: 30 },
        { line: 6, top: 50 },
        { line: 7, top: 50 },
        { line: 8, top: 70 },
      ],
      [],
      [{ line: 10, top: 70 }],
      [{ line: 11, top: 100 }],
      [{ line: 13, top: 140 }],
      [{ line: 30, top: 600 }],
      [
        { line: 12, top: 700 },
        { line: 4, top: 720 },
        { line: 33, top: 760 },
        { line: 34, top: 780 },
      ],
    ]
    const lines = 35
    const height = 820
    const all = measuredAll(pieces, lines, height)
    const preview = fakePreview(pieces, height)
    const pane = previewScrollPane(preview.scroller)
    pane.rendered(lines, preview.runs)
    for (let line = 0; line <= lines + 2; line += 0.25) {
      expect([line, pane.offsetOf(line)]).toEqual([line, topOf(all, line)])
    }
    for (let top = 0; top <= height - 100; top += 5) {
      preview.element.scrollTop = top
      expect([top, pane.topLine()]).toEqual([top, lineAt(all, top)])
    }
    pane.dispose()
  })

  it('agrees with measuring every block over notes of every shape', () => {
    stubResizeObserver()
    let seed = 7
    const random = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647
    for (let note = 0; note < 40; note += 1) {
      const pieces: FakeBlock[][] = []
      let line = 1 + Math.floor(random() * 3)
      let top = Math.floor(random() * 2) * 20
      for (let piece = 0; piece < 30; piece += 1) {
        const blocks: FakeBlock[] = []
        const count = Math.floor(random() * 4)
        for (let k = 0; k < count; k += 1) {
          blocks.push({ line, top })
          line += Math.floor(random() * 3)
          top += Math.floor(random() * 3) * 15
        }
        pieces.push(blocks)
        line += 1 + Math.floor(random() * 2)
        top += Math.floor(random() * 2) * 25
      }
      if (random() < 0.5)
        pieces.push([
          { line: 2, top: top + 10 },
          { line: line + 1, top: top + 40 },
        ])
      const lines = line + 3
      const height = top + 300
      const all = measuredAll(pieces, lines, height)
      const preview = fakePreview(pieces, height)
      const pane = previewScrollPane(preview.scroller)
      pane.rendered(lines, preview.runs)
      for (let at = 0; at <= lines + 2; at += 0.5) expect(pane.offsetOf(at)).toBe(topOf(all, at))
      for (let at = 0; at <= height - 100; at += 7) {
        preview.element.scrollTop = at
        expect(pane.topLine()).toBe(lineAt(all, at))
      }
      pane.dispose()
    }
  })

  it('agrees with measuring every block when blocks inside a piece go back up', () => {
    stubResizeObserver()
    const check = (pieces: FakeBlock[][], lines: number, height: number) => {
      const all = measuredAll(pieces, lines, height)
      const preview = fakePreview(pieces, height)
      const pane = previewScrollPane(preview.scroller)
      pane.rendered(lines, preview.runs)
      for (let at = 0; at <= lines + 2; at += 0.5)
        expect([at, pane.offsetOf(at)]).toEqual([at, topOf(all, at)])
      for (let at = 0; at <= height - 100; at += 5) {
        preview.element.scrollTop = at
        expect([at, pane.topLine()]).toEqual([at, lineAt(all, at)])
      }
      pane.dispose()
    }
    check(
      [
        [{ line: 1, top: 0 }],
        [
          { line: 10, top: 100 },
          { line: 5, top: 50 },
        ],
        [
          { line: 7, top: 70 },
          { line: 20, top: 200 },
        ],
        [{ line: 22, top: 240 }],
      ],
      24,
      400,
    )
    // Each piece reaches past every block before it somewhere, not always at its end.
    let seed = 11
    const random = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647
    const step = (n: number) => Math.floor(random() * n)
    for (let note = 0; note < 40; note += 1) {
      const pieces: FakeBlock[][] = []
      let line = 1
      let top = 0
      for (let piece = 0; piece < 30; piece += 1) {
        const count = step(4)
        const high = step(count)
        const blocks: FakeBlock[] = []
        for (let k = 0; k < count; k += 1)
          blocks.push(
            k === high
              ? { line: line + 1 + step(3), top: top + 15 + step(3) * 15 }
              : {
                  line: Math.max(1, line - 3 + step(7)),
                  top: Math.max(0, top - 30 + step(5) * 15),
                },
          )
        for (const block of blocks) {
          line = Math.max(line, block.line)
          top = Math.max(top, block.top)
        }
        pieces.push(blocks)
      }
      check(pieces, line + 3, top + 300)
    }
  })

  it('measures a kept piece afresh when it changed inside along with a render', () => {
    stubResizeObserver()
    const pieces = [
      [
        { line: 1, top: 0 },
        { line: 3, top: 40 },
      ],
      [{ line: 6, top: 100 }],
    ]
    const preview = fakePreview(pieces, 200)
    const pane = previewScrollPane(preview.scroller)
    pane.rendered(8, preview.runs)
    expect(pane.offsetOf(3)).toBe(40)
    // A larger font lands in the same frame as an edit further down.
    pieces[0]![1]!.top = 60
    pieces[1]![0]!.top = 150
    preview.element.scrollHeight = 300
    pane.rendered(8, preview.runs)
    expect(pane.offsetOf(3)).toBe(60)
    expect(pane.offsetOf(2)).toBe(30)
    pane.dispose()
  })

  it('maps pieces built after the render, keeping what it measured of the others', () => {
    stubResizeObserver()
    const note = bigNote(100)
    const waitFrom = 150
    const waitLine = note.pieces[waitFrom]![0]!.line
    const builtHeight = note.pieces[waitFrom]![0]!.top
    const preview = fakePreview(note.pieces, builtHeight)
    const runs = preview.runs.map((run, at) =>
      at < waitFrom ? run : { line: run.line, marked: [] as Element[], pending: [] },
    )
    const frame = frameQueue()
    const pane = previewScrollPane(preview.scroller, frame)
    pane.rendered(note.lines, runs)
    let laidOut = 0
    pane.onLayout!(() => laidOut++)
    // What is not built yet sits below the bottom, rather than squeezed into the last pixels.
    const built = measuredAll(note.pieces.slice(0, waitFrom), waitLine - 1, builtHeight)
    preview.element.scrollTop = builtHeight - 30
    expect(pane.topLine()).toBe(lineAt(built, builtHeight - 30))
    expect(pane.offsetOf(waitLine + 100)).toBe(builtHeight)
    expect(pane.offsetOf(80)).toBe(topOf(built, 80))
    for (const [at, run] of runs.entries()) {
      if (at < waitFrom) continue
      Object.assign(run, { marked: preview.runs[at]!.marked })
      delete (run as { pending?: unknown }).pending
    }
    preview.element.scrollHeight = note.height
    preview.counter.reads = 0
    pane.built()
    const all = measuredAll(note.pieces, note.lines, note.height)
    expect(pane.offsetOf(waitLine + 100)).toBe(topOf(all, waitLine + 100))
    expect(pane.offsetOf(80)).toBe(topOf(all, 80))
    expect(pane.topLine()).toBe(lineAt(all, builtHeight - 30))
    expect(preview.counter.reads).toBeLessThan(30)
    frame.flush()
    expect(laidOut).toBe(1)
    pane.dispose()
  })

  it('reads a line its `reach` builds as built, after a look past the bottom', () => {
    stubResizeObserver()
    const note = bigNote(20)
    const waitFrom = 30
    const preview = fakePreview(note.pieces, note.pieces[waitFrom]![0]!.top)
    const runs = preview.runs.map((run, at) =>
      at < waitFrom ? run : { line: run.line, marked: [] as Element[], pending: [] },
    )
    const reach = (line: number) => {
      let at = waitFrom
      for (; at < runs.length && runs[at]!.line <= line + 8; at += 1) {
        if (!('pending' in runs[at]!)) continue
        Object.assign(runs[at]!, { marked: preview.runs[at]!.marked })
        delete (runs[at] as { pending?: unknown }).pending
      }
      preview.element.scrollHeight = note.pieces[at]?.[0]!.top ?? note.height
      pane.built()
    }
    const pane = previewScrollPane(preview.scroller, { ...frameQueue(), reach })
    pane.rendered(note.lines, runs)
    preview.element.scrollTop = preview.element.scrollHeight - 10
    pane.topLine()
    const line = note.pieces[waitFrom + 4]![0]!.line
    const all = measuredAll(note.pieces, note.lines, note.height)
    expect(pane.offsetOf(line)).toBe(topOf(all, line))
    pane.dispose()
  })

  it('measures afresh when the content changed height on its own (a diagram)', () => {
    stubResizeObserver()
    const pieces = [[{ line: 1, top: 0 }], [{ line: 4, top: 50 }]]
    const preview = fakePreview(pieces, 100)
    const pane = previewScrollPane(preview.scroller)
    pane.rendered(5, preview.runs)
    expect(pane.offsetOf(4)).toBe(50)
    pieces[1]![0]!.top = 250
    preview.element.scrollHeight = 300
    expect(pane.offsetOf(4)).toBe(250)
    pane.dispose()
  })
})

class FakePane implements ScrollPane {
  readonly element = Object.assign(new EventTarget(), {
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 100,
  })
  scrolledTo: number[] = []
  private layout = new Set<() => void>()
  private moves = new Set<() => void>()
  /** Content added above the first line, in pixels. */
  private above = 0
  constructor(private readonly scale = 1) {}
  topLine() {
    return (this.element.scrollTop - this.above) / this.scale + 1
  }
  offsetOf(line: number) {
    this.scrolledTo.push(line)
    return (line - 1) * this.scale + this.above
  }
  onLayout(listener: () => void) {
    this.layout.add(listener)
    return () => this.layout.delete(listener)
  }
  onMove(listener: () => void) {
    this.moves.add(listener)
    return () => this.moves.delete(listener)
  }
  /** Content above the view grew by `by`; a pane that `keeps` its line moves itself by as much. */
  growAbove(by: number, { keeps = true } = {}) {
    this.above += by
    this.element.scrollHeight += by
    if (!keeps) return
    this.set(this.element.scrollTop + by)
    for (const listener of this.moves) listener()
  }
  set(top: number) {
    const max = this.element.scrollHeight - this.element.clientHeight
    this.element.scrollTop = Math.max(0, Math.min(max, top))
  }
  fire() {
    this.element.dispatchEvent(new Event('scroll'))
  }
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
  wheel(deltaY: number, more: object = {}) {
    const event = Object.assign(new Event('wheel', { cancelable: true }), {
      deltaX: 0,
      deltaY,
      deltaMode: 0,
      ...more,
    })
    this.element.dispatchEvent(event)
    return event.defaultPrevented
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

  it('takes a pane moving itself to keep its line in view for no lead', () => {
    const { editor, preview, flush } = setup({ previewHeight: 3000 })
    flush()
    editor.userScroll(30)
    flush()
    expect(preview.element.scrollTop).toBe(60)
    // Diagrams above the preview's view land together, 500 px taller between them.
    preview.growAbove(500)
    preview.relayout()
    preview.fire()
    flush()
    expect(editor.scrolledTo).toEqual([])
    expect(editor.element.scrollTop).toBe(30)
    expect(preview.element.scrollTop).toBe(560)
    // The editor still leads: the next rendering lines the preview up with it.
    preview.growAbove(40, { keeps: false })
    preview.relayout()
    flush()
    expect(preview.element.scrollTop).toBe(600)
  })

  it('takes the scroll a pane is clamped to while laid out anew for no lead', () => {
    const { editor, preview, flush } = setup()
    flush()
    editor.userScroll(30)
    flush()
    // The preview got shorter: the browser clamps its offset to the new end and reports it.
    preview.element.scrollHeight = 120
    preview.relayout()
    preview.userScroll(20)
    flush()
    expect(editor.element.scrollTop).toBe(30)
    expect(preview.element.scrollTop).toBe(20)
  })

  it('keeps a scroll that comes in the frame after its pane was laid out anew', () => {
    const { editor, preview, flush } = setup()
    flush()
    preview.relayout()
    preview.userScroll(400)
    flush()
    expect(preview.element.scrollTop).toBe(400)
    expect(editor.element.scrollTop).toBe(200)
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

  it('a scroll whose lines change height as they draw still leads', () => {
    const { editor, preview, flush } = setup({ lead: 'second' })
    flush()
    editor.set(400)
    editor.relayout()
    editor.fire()
    flush()
    expect(editor.element.scrollTop).toBe(400)
    expect(preview.element.scrollTop).toBeGreaterThan(0)
  })

  it('still lines a clamped pane up when it is laid out twice before the clamp is reported', () => {
    const { editor, preview, flush } = setup()
    flush()
    editor.userScroll(30)
    flush()
    preview.element.scrollHeight = 150
    preview.set(preview.element.scrollTop)
    preview.relayout()
    preview.relayout()
    preview.fire()
    flush()
    expect(editor.element.scrollTop).toBe(30)
    expect(preview.element.scrollTop).toBe(50)
  })

  it('keeps a scroll whose event is late when its pane is laid out twice first', () => {
    const { editor, preview, flush } = setup()
    flush()
    preview.set(400)
    preview.relayout()
    preview.relayout()
    preview.fire()
    flush()
    expect(preview.element.scrollTop).toBe(400)
    expect(editor.element.scrollTop).toBe(200)
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

  it('moves both panes in the wheel event itself, before any frame', () => {
    const { editor, preview, flush } = setup()
    flush()
    expect(editor.wheel(30)).toBe(true)
    expect(editor.element.scrollTop).toBe(30)
    expect(preview.element.scrollTop).toBe(60)
    expect(preview.wheel(40)).toBe(true)
    expect(preview.element.scrollTop).toBe(100)
    expect(editor.element.scrollTop).toBe(50)
    // Their scroll events are Devot's own: nothing moves back.
    editor.fire()
    preview.fire()
    flush()
    expect(editor.element.scrollTop).toBe(50)
    expect(preview.element.scrollTop).toBe(100)
  })

  it('keeps every fraction of a trackpad scroll', () => {
    const { editor, preview, flush } = setup()
    flush()
    // The element keeps whole pixels only.
    let top = 0
    Object.defineProperty(editor.element, 'scrollTop', {
      get: () => top,
      set: (value: number) => (top = Math.round(value)),
    })
    for (let i = 0; i < 8; i++) editor.wheel(0.4)
    expect(editor.element.scrollTop).toBe(3)
    expect(preview.element.scrollTop).toBe(6)
  })

  it('stops both panes at their ends together', () => {
    const { editor, preview, flush } = setup({ previewHeight: 3000 })
    flush()
    editor.wheel(5000)
    expect(editor.element.scrollTop).toBe(900)
    expect(preview.element.scrollTop).toBe(2900)
    preview.wheel(-99999)
    expect(preview.element.scrollTop).toBe(0)
    expect(editor.element.scrollTop).toBe(0)
  })

  it('leaves to the browser a wheel it cannot follow', () => {
    const { editor, preview, flush } = setup()
    flush()
    expect(editor.wheel(10, { deltaX: 30 })).toBe(false)
    expect(editor.wheel(10, { ctrlKey: true })).toBe(false)
    editor.element.scrollHeight = 100
    expect(preview.wheel(10)).toBe(false)
    expect(editor.element.scrollTop).toBe(0)
  })

  it('takes a wheel over the follower as the new lead at once', () => {
    const { editor, preview, flush } = setup()
    flush()
    editor.wheel(100)
    flush()
    // Momentum from the editor's own scroll after the user moves to the preview.
    preview.wheel(20)
    editor.userScroll(400)
    flush()
    // The editor's stray scroll is not followed: it goes back to the preview's line.
    expect(preview.element.scrollTop).toBe(220)
    expect(editor.element.scrollTop).toBe(110)
  })

  it('stops listening when stopped', () => {
    const { editor, preview, stop, flush, frames } = setup()
    editor.userScroll(30)
    stop()
    expect(frames).toEqual([])
    editor.userScroll(60)
    expect(editor.wheel(10)).toBe(false)
    preview.relayout()
    flush()
    expect(preview.scrolledTo).toEqual([])
  })
})
