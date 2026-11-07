// Synced scrolling in split mode: the editor and the preview show the same
// place in the note. Both panes speak in source lines (fractional, 1-based):
// the editor knows its lines; the preview knows the line each block starts on
// (`data-source-line`, set by the core) and interpolates between blocks.
//
// A wheel or trackpad scroll over either pane moves both panes in the same
// event, so they reach the screen in the same frame and the follower stays
// attached to the finger, momentum included. Any other scroll (keys, the
// scroll bar, find) moves the other pane once per frame. A pane's scroll that
// Devot made itself is never taken for the user's, so nothing echoes back.
// The preview measures only the blocks around the place asked for and keeps
// them until its layout changes, so scrolling and typing in a long note stay
// cheap.

export interface Anchor {
  line: number
  top: number
}

/**
 * Anchors in document order, made safe to interpolate over: a start at line 1
 * at the top, the end of the note at the bottom (`end`), and lines and
 * offsets that only ever go down (a block that would not, such as a nested
 * list item on its list's line, a block at the same offset as the one before
 * or a footnote, is dropped).
 */
export function normalizeAnchors(raw: readonly Anchor[], end: Anchor): Anchor[] {
  const out: Anchor[] = [{ line: 1, top: 0 }]
  for (const anchor of raw) keep(out, anchor)
  keep(out, end)
  return out
}

/** Adds `anchor` to anchors normalized so far, as `normalizeAnchors` would. */
function keep(out: Anchor[], anchor: Anchor): void {
  const last = out[out.length - 1]!
  if (out.length === 1 && last.line === 1 && anchor.line === 1 && anchor.top >= 0) out[0] = anchor
  else if (anchor.line > last.line && anchor.top > last.top) out.push(anchor)
}

function around(anchors: readonly Anchor[], key: keyof Anchor, value: number) {
  let lo = 0
  let hi = anchors.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (anchors[mid]![key] <= value) lo = mid
    else hi = mid - 1
  }
  return { a: anchors[lo]!, b: anchors[Math.min(lo + 1, anchors.length - 1)]! }
}

export function topOf(anchors: readonly Anchor[], line: number): number {
  const first = anchors[0]!
  const last = anchors[anchors.length - 1]!
  if (line <= first.line) return first.top
  if (line >= last.line) return last.top
  const { a, b } = around(anchors, 'line', line)
  if (b.line === a.line) return a.top
  return a.top + ((line - a.line) / (b.line - a.line)) * (b.top - a.top)
}

export function lineAt(anchors: readonly Anchor[], top: number): number {
  const first = anchors[0]!
  const last = anchors[anchors.length - 1]!
  if (top <= first.top) return first.line
  if (top >= last.top) return last.line
  const { a, b } = around(anchors, 'top', top)
  if (b.top === a.top) return a.line
  return a.line + ((top - a.top) / (b.top - a.top)) * (b.line - a.line)
}

export interface Scroller extends EventTarget {
  scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

export interface ScrollPane {
  readonly element: Scroller
  topLine(): number
  offsetOf(line: number): number
  onLayout?(listener: () => void): () => void
  /** The pane moved its own scroll position to keep showing what it showed (content above it grew): that scroll is no lead. */
  onMove?(listener: () => void): () => void
}

export interface SyncOptions {
  lead?: 'first' | 'second'
  frame?: (run: () => void) => number
  cancel?: (handle: number) => void
  now?: () => number
}

/**
 * Input that shows the pane the user works in, without scrolling it. (Unlike
 * a wheel or a touch, a click or a key is no scroll gesture: it may scroll
 * nothing, while the other pane scrolls for a reason of its own, such as find.)
 */
const WORK = ['keydown', 'pointerdown'] as const
const GESTURE_HOLD_MS = 500
const WHEEL_LINE_PX = 40

export interface WheelInput {
  readonly deltaX: number
  readonly deltaY: number
  readonly deltaMode: number
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
}

/**
 * How far down a wheel event scrolls a pane `page` pixels tall, or null for
 * one that is not a plain vertical scroll (sideways, or a pinch to zoom).
 */
export function wheelDistance(event: WheelInput, page: number): number | null {
  const { deltaX, deltaY, deltaMode } = event
  if (event.ctrlKey || event.metaKey) return null
  if (!Number.isFinite(deltaY) || deltaY === 0) return null
  if (Math.abs(deltaX) > Math.abs(deltaY)) return null
  if (deltaMode === 1) return deltaY * WHEEL_LINE_PX
  if (deltaMode === 2) return deltaY * page
  return deltaY
}

function scrolledInside(target: unknown, pane: unknown, dy: number): boolean {
  if (typeof Element === 'undefined') return false
  for (let el = target instanceof Element ? target : null; el && el !== pane;) {
    if (el.scrollHeight > el.clientHeight + 1) {
      const overflow = getComputedStyle(el).overflowY
      if (overflow === 'auto' || overflow === 'scroll') {
        const room = dy < 0 ? el.scrollTop : el.scrollHeight - el.clientHeight - el.scrollTop
        if (room >= 1) return true
      }
    }
    el = el.parentElement
  }
  return false
}

const maxOffset = (el: Scroller) => Math.max(0, el.scrollHeight - el.clientHeight)
const atEnd = (pane: ScrollPane) => pane.element.scrollTop >= maxOffset(pane.element) - 1

/**
 * Where the follower goes for the leader's position: the matching line, and
 * over the leader's last screen a blend towards the follower's own end, so
 * both reach their ends together without a jump.
 */
function followOffset(from: ScrollPane, to: ScrollPane): number {
  const source = from.element
  const target = to.element
  if (source.scrollTop <= 0) return 0
  const end = maxOffset(target)
  let top = to.offsetOf(from.topLine())
  const remaining = maxOffset(source) - source.scrollTop
  const span = Math.min(source.clientHeight, maxOffset(source))
  if (remaining < span) top += (end - top) * (1 - Math.max(0, remaining) / span)
  return Math.min(end, Math.max(0, top))
}

/**
 * Keeps `second` at the line `first` shows, and the other way round, until
 * the returned function is called. When a pane is laid out anew it lines up
 * with the other, unless the user was last working in it.
 */
export function syncScrolling(
  first: ScrollPane,
  second: ScrollPane,
  {
    lead = 'first',
    frame = (run) => requestAnimationFrame(run),
    cancel = (handle) => cancelAnimationFrame(handle),
    now = () => performance.now(),
  }: SyncOptions = {},
): () => void {
  const other = (pane: ScrollPane) => (pane === first ? second : first)
  const expected = new Map<ScrollPane, number>()
  let gesture: { pane: ScrollPane; at: number } | undefined
  let current = lead === 'first' ? first : second
  let leader: ScrollPane | undefined
  let relayout = false
  let check: { pane: ScrollPane; top: number; tries: number } | undefined
  let handle: number | undefined

  const seen = new Map<ScrollPane, number>()
  const note = (pane: ScrollPane) => seen.set(pane, pane.element.scrollTop)
  // Panes that moved with their scroll event still to come: more layout
  // before it must not take the pane for one the user left alone.
  const moving = new Set<ScrollPane>()

  const schedule = (pane: ScrollPane, laidOut = false) => {
    // A pane that shrank reports the scroll it was clamped to, at its new end; that is no lead.
    // Any other scroll in the frame after a layout is the user's, and leads.
    if (relayout && pane !== leader && (laidOut || atEnd(pane))) return
    leader = pane
    if (!laidOut) current = pane
    relayout ||= laidOut
    handle ??= frame(follow)
  }

  // Reads the leader, then writes the follower: one layout read and one
  // write per frame however many scroll events arrived.
  //
  // A move is looked at again over the next frames: the editor knows the
  // height of a line it has not shown only once it has, so the line moved to
  // can sit a little off until it is laid out.
  function follow() {
    handle = undefined
    moving.clear()
    const again =
      leader === undefined && check?.pane === current && check.top === check.pane.element.scrollTop
        ? check
        : undefined
    const from = leader ?? again?.pane
    leader = undefined
    check = undefined
    relayout = false
    if (!from || maxOffset(from.element) < 1) return
    const to = other(from)
    const target = to.element
    const before = target.scrollTop
    const want = followOffset(from, to)
    if (again && Math.abs(want - before) < 1) return
    target.scrollTop = want
    const after = target.scrollTop
    if (after === before) return
    expected.set(to, after)
    note(to)
    const tries = again ? again.tries + 1 : 0
    if (tries < 2) {
      check = { pane: from, top: from.element.scrollTop, tries }
      handle = frame(follow)
    }
  }

  const place = (pane: ScrollPane, top: number) => {
    const el = pane.element
    const before = el.scrollTop
    el.scrollTop = top
    if (el.scrollTop !== before) expected.set(pane, el.scrollTop)
    note(pane)
  }
  const exact = new Map<ScrollPane, number>()

  // A wheel over a pane scrolls it here, rather than in the browser, and
  // moves the other pane in the same event: both show the change in the
  // same frame. A frame later the other pane is checked again (the editor
  // learns the height of a line only once it shows it).
  const onWheel = (pane: ScrollPane) => (event: Event) => {
    gesture = { pane, at: now() }
    current = pane
    const el = pane.element
    const dy = wheelDistance(event as unknown as WheelInput, el.clientHeight)
    if (dy === null || event.defaultPrevented) return
    if (scrolledInside(event.target, el, dy)) return
    const to = other(pane)
    if (maxOffset(el) < 1 || maxOffset(to.element) < 1) return
    event.preventDefault()
    const kept = exact.get(pane)
    const from = kept !== undefined && Math.abs(kept - el.scrollTop) < 1 ? kept : el.scrollTop
    const top = Math.min(maxOffset(el), Math.max(0, from + dy))
    exact.set(pane, top)
    place(pane, top)
    place(to, followOffset(pane, to))
    exact.delete(to)
    leader = pane
    handle ??= frame(follow)
  }

  const onScroll = (pane: ScrollPane) => () => {
    note(pane)
    moving.delete(pane)
    const want = expected.get(pane)
    if (want !== undefined) {
      expected.delete(pane)
      // The scroll Devot made: never sent back.
      if (Math.abs(pane.element.scrollTop - want) < 1) return
    }
    // Momentum in the pane the user just left must not pull the one they scroll now.
    if (gesture && gesture.pane !== pane && now() - gesture.at < GESTURE_HOLD_MS) return
    schedule(pane)
  }

  const stops: (() => void)[] = []
  const listen = (
    target: Scroller,
    type: string,
    listener: (event: Event) => void,
    { capture = false, passive = true } = {},
  ) => {
    target.addEventListener(type, listener, { passive, capture })
    stops.push(() => target.removeEventListener(type, listener, { capture }))
  }
  for (const pane of [first, second]) {
    note(pane)
    listen(pane.element, 'scroll', onScroll(pane))
    listen(pane.element, 'wheel', onWheel(pane), { passive: false })
    listen(
      pane.element,
      'touchstart',
      () => {
        gesture = { pane, at: now() }
        current = pane
      },
      { capture: true },
    )
    for (const type of WORK) listen(pane.element, type, () => (current = pane), { capture: true })
    const stopLayout = pane.onLayout?.(() => {
      // Drawing lines just scrolled to also changes heights: that scroll's own event still leads.
      if (moving.has(pane)) return
      if (pane.element.scrollTop !== seen.get(pane)) {
        note(pane)
        // A pane at its end was most likely clamped by a shorter layout, which is no lead.
        if (!atEnd(pane)) moving.add(pane)
        return
      }
      if (current !== pane) schedule(other(pane), true)
    })
    if (stopLayout) stops.push(stopLayout)
    const stopMove = pane.onMove?.(() => {
      expected.set(pane, pane.element.scrollTop)
      note(pane)
    })
    if (stopMove) stops.push(stopMove)
  }
  schedule(current)

  return () => {
    for (const stop of stops) stop()
    if (handle !== undefined) cancel(handle)
    handle = undefined
  }
}

export interface PreviewScrollPane extends ScrollPane {
  /** The preview now shows `pieces`, of a note `lines` lines long. */
  rendered(lines: number, pieces: readonly PreviewPiece[]): void
  /** Something in the preview changed size without a render (a diagram drawn). */
  changed(): void
  dispose(): void
}

/**
 * One piece of the preview as its scroll pane reads it: the line it starts
 * on, and among `marked`, in document order, its blocks that carry a line.
 * A piece that stays the same object kept its blocks (its lines may move).
 */
export interface PreviewPiece {
  readonly line: number
  readonly marked: readonly Element[]
}

const shifts = new WeakMap<Element, (by: number) => void>()

/**
 * Scrolls `element` by `by` pixels to keep what is in view where it is
 * (content above it grew). Through its preview scroll pane, when it has one,
 * so synced scrolling does not take the move for the user's.
 */
export function shiftScroll(element: HTMLElement, by: number): void {
  const shift = shifts.get(element)
  if (shift) shift(by)
  else element.scrollTop += by
}

const passes = (anchor: Anchor, before: readonly Anchor[]) =>
  before.every((other) => anchor.line > other.line && anchor.top > other.top)

const lineOf = (el: Element) => {
  const line = Number(el.getAttribute('data-source-line'))
  return Number.isInteger(line) && line >= 1 ? line : undefined
}

interface Shape {
  blocks: Element[]
  /** Each block's offset below the first. */
  below: number[]
}

/**
 * The preview as a scroll pane: `element` scrolls and its pieces' blocks
 * carry their source lines. It measures only the blocks around the place
 * asked for, finding them by a search over the pieces: a big note costs a
 * few dozen box reads after a render rather than one for every block. What
 * it measured inside a piece holds until the content is laid out anew (an
 * image or a diagram, a new width, a height that changed without a render);
 * where a piece sits holds until anything changes. `reach` builds what the
 * preview has not built yet up to a line it is asked for.
 */
export function previewScrollPane(
  element: HTMLElement,
  {
    reach,
    frame = (run) => requestAnimationFrame(run),
    cancel = (handle) => cancelAnimationFrame(handle),
  }: { reach?: (line: number) => void } & Pick<SyncOptions, 'frame' | 'cancel'> = {},
): PreviewScrollPane {
  let lines = 1
  let pieces: readonly PreviewPiece[] = []
  /** The pieces a search may land on: those whose lines go up in document order (not the footnotes, mostly). */
  let ordered: number[] = []
  let filled: number | undefined
  let height = -1
  let told = false
  let epoch = 0
  let shapes = new WeakMap<PreviewPiece, Shape>()
  const heads = new WeakMap<PreviewPiece, { epoch: number; top: number | undefined }>()
  const placed = new WeakMap<PreviewPiece, { epoch: number; anchors: Anchor[] }>()
  let paneTop = { epoch: -1, top: 0 }
  const listeners = new Set<() => void>()
  const moves = new Set<() => void>()

  const relaidOut = () => {
    shapes = new WeakMap()
    epoch += 1
    told = true
  }
  const fresh = () => {
    const now = element.scrollHeight
    if (now !== height) {
      // Grown or shrunk with nothing said: anything inside may have moved.
      if (!told) shapes = new WeakMap()
      epoch += 1
      height = now
    }
    told = false
  }
  const origin = () => {
    if (paneTop.epoch !== epoch)
      paneTop = { epoch, top: element.getBoundingClientRect().top + element.clientTop }
    return paneTop.top - element.scrollTop
  }

  const headTop = (piece: PreviewPiece) => {
    const known = heads.get(piece)
    if (known?.epoch === epoch) return known.top
    const first =
      shapes.get(piece)?.blocks[0] ?? piece.marked.find((el) => lineOf(el) !== undefined)
    const top = first ? first.getBoundingClientRect().top - origin() : undefined
    heads.set(piece, { epoch, top })
    return top
  }

  const anchorsOf = (piece: PreviewPiece): Anchor[] => {
    const known = placed.get(piece)
    if (known?.epoch === epoch) return known.anchors
    let shape = shapes.get(piece)
    // A kept piece that changed inside with nothing said (a new font along with a render) shows it at its last block.
    if (shape && shape.blocks.length > 1) {
      const last = shape.blocks[shape.blocks.length - 1]!.getBoundingClientRect().top - origin()
      if (last - (headTop(piece) ?? 0) !== shape.below[shape.below.length - 1]) shape = undefined
    }
    if (!shape) {
      const blocks = piece.marked.filter((el) => lineOf(el) !== undefined)
      const tops = blocks.map((el) => el.getBoundingClientRect().top - origin())
      shape = { blocks, below: tops.map((top) => top - tops[0]!) }
      shapes.set(piece, shape)
      heads.set(piece, { epoch, top: tops[0] })
    }
    const top = headTop(piece) ?? 0
    const anchors: Anchor[] = []
    for (const [at, el] of shape.blocks.entries()) {
      const line = lineOf(el)
      if (line !== undefined) anchors.push({ line, top: top + shape.below[at]! })
    }
    placed.set(piece, { epoch, anchors })
    return anchors
  }

  /** The last piece a search may land on that starts at or before `value`, or -1. */
  const search = (key: keyof Anchor, value: number) => {
    let lo = 0
    let hi = ordered.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      let at = mid
      let start: number | undefined
      for (; at <= hi; at += 1) {
        const piece = pieces[ordered[at]!]!
        start = key === 'line' ? piece.line : headTop(piece)
        if (start !== undefined) break
      }
      if (start === undefined || start > value) hi = mid - 1
      else {
        found = at
        lo = at + 1
      }
    }
    return found < 0 ? -1 : ordered[found]!
  }

  const filledBefore = (at: number) => {
    let back = at - 1
    while (back >= 0 && anchorsOf(pieces[back]!).length === 0) back -= 1
    return back
  }

  /**
   * The last anchor before piece `at`, as normalizing every anchor would
   * leave it. A piece's first block is kept when it lies past every block of
   * the piece before it, in line and offset; otherwise (a piece of no height)
   * the pieces before it are looked at too. That is exact while each piece
   * reaches, somewhere, past every block before it.
   */
  const lastBefore = (at: number): Anchor[] => {
    filled ??= pieces.findIndex((piece) => piece.marked.some((el) => lineOf(el) !== undefined))
    const runs: Anchor[][] = []
    let out: Anchor[] = [{ line: 1, top: 0 }]
    for (let back = filledBefore(at); back >= 0;) {
      const anchors = anchorsOf(pieces[back]!)
      if (back === filled) {
        runs.push(anchors)
        break
      }
      const prior = filledBefore(back)
      const first = anchors[0]!
      if (prior < 0 || passes(first, anchorsOf(pieces[prior]!))) {
        out = [first]
        runs.push(anchors.slice(1))
        break
      }
      runs.push(anchors)
      back = prior
    }
    for (const run of runs.reverse()) for (const anchor of run) keep(out, anchor)
    return [out[out.length - 1]!]
  }

  /** The normalized anchors from the last one at or before `value` to the first after it. */
  // The last anchors found are a run of the normalized ones: any place within them is found there.
  let found = { epoch: -1, anchors: [] as Anchor[] }
  const nearby = (key: keyof Anchor, value: number): Anchor[] => {
    fresh()
    if (found.epoch === epoch) {
      const { anchors } = found
      if (anchors[0]![key] <= value && value < anchors[anchors.length - 1]![key]) return anchors
    }
    const out = measureAround(key, value)
    found = { epoch, anchors: out }
    return out
  }
  const measureAround = (key: keyof Anchor, value: number): Anchor[] => {
    let at = Math.max(search(key, value), 0)
    let out = lastBefore(at)
    // The piece found by its first block can keep only blocks past the place: start earlier.
    while (at > 0 && out[0]![key] > value) out = lastBefore((at -= 1))
    for (let next = at; next < pieces.length; next += 1) {
      for (const anchor of anchorsOf(pieces[next]!)) {
        keep(out, anchor)
        if (out.length > 1 && out[out.length - 1]![key] > value) return out
      }
    }
    keep(out, { line: lines + 1, top: height })
    return out
  }
  const lineFor = (top: number) => lineAt(nearby('top', top), top)
  const topFor = (line: number) => topOf(nearby('line', line), line)

  const notify = () => {
    for (const listener of listeners) listener()
  }
  // Images and diagrams land a few at a time: the panes line up again once a frame.
  let pending: number | undefined
  const resized = () => {
    relaidOut()
    pending ??= frame(() => {
      pending = undefined
      notify()
    })
  }
  // The line read, as of the last scroll.
  let read: number | undefined
  const scrolled = () => {
    read = element.scrollTop > 0 ? lineFor(element.scrollTop) : undefined
  }
  element.addEventListener('scroll', scrolled, { passive: true })
  // A narrower or wider pane wraps its text anew, and keeps the line read at
  // its top (WebKit has no scroll anchoring to do it).
  const resize = new ResizeObserver(() => {
    relaidOut()
    if (read !== undefined) element.scrollTop = topFor(read)
    notify()
  })
  resize.observe(element)
  element.addEventListener('load', resized, true)
  const shift = (by: number) => {
    const before = element.scrollTop
    element.scrollTop = before + by
    if (element.scrollTop !== before) for (const listener of moves) listener()
  }
  shifts.set(element, shift)

  return {
    element,
    topLine: () => lineFor(element.scrollTop),
    offsetOf: (line) => {
      reach?.(line)
      return topFor(line)
    },
    onLayout: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onMove: (listener) => {
      moves.add(listener)
      return () => moves.delete(listener)
    },
    rendered: (count, next) => {
      lines = count
      pieces = next
      ordered = []
      for (const [at, piece] of next.entries()) {
        const last = ordered[ordered.length - 1]
        if (last === undefined || piece.line > next[last]!.line) ordered.push(at)
      }
      filled = undefined
      epoch += 1
      told = true
      notify()
    },
    changed: resized,
    dispose: () => {
      resize.disconnect()
      element.removeEventListener('scroll', scrolled)
      element.removeEventListener('load', resized, true)
      if (pending !== undefined) cancel(pending)
      pending = undefined
      listeners.clear()
      moves.clear()
      if (shifts.get(element) === shift) shifts.delete(element)
    },
  }
}
