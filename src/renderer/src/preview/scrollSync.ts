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
// The preview measures its blocks once per layout, so scrolling a long note
// stays cheap.

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
  for (const anchor of [...raw, end]) {
    const last = out[out.length - 1]!
    if (out.length === 1 && anchor.line === 1 && anchor.top >= 0) out[0] = anchor
    else if (anchor.line > last.line && anchor.top > last.top) out.push(anchor)
  }
  return out
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

  const schedule = (pane: ScrollPane, laidOut = false) => {
    // A pane that shrank reports the scroll it was clamped to; that is no lead.
    if (relayout && pane !== leader) return
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
      if (current !== pane) schedule(other(pane), true)
    })
    if (stopLayout) stops.push(stopLayout)
  }
  schedule(current)

  return () => {
    for (const stop of stops) stop()
    if (handle !== undefined) cancel(handle)
    handle = undefined
  }
}

export interface PreviewScrollPane extends ScrollPane {
  changed(lines?: number): void
  dispose(): void
}

/**
 * The preview as a scroll pane: `element` scrolls and its blocks carry their
 * source lines. Block offsets are measured once and kept until the content
 * changes size or is rendered anew, so scrolling reads no layout but the
 * scroll offset.
 */
export function previewScrollPane(element: HTMLElement): PreviewScrollPane {
  let lines = 1
  let anchors: Anchor[] | undefined
  let measuredHeight = -1
  const listeners = new Set<() => void>()

  const measure = (): Anchor[] => {
    const height = element.scrollHeight
    if (anchors && height === measuredHeight) return anchors
    const origin = element.getBoundingClientRect().top - element.scrollTop + element.clientTop
    const raw: Anchor[] = []
    for (const block of element.querySelectorAll<HTMLElement>('[data-source-line]')) {
      const line = Number(block.dataset['sourceLine'])
      if (!Number.isInteger(line) || line < 1) continue
      raw.push({ line, top: block.getBoundingClientRect().top - origin })
    }
    measuredHeight = height
    anchors = normalizeAnchors(raw, { line: lines + 1, top: height })
    return anchors
  }

  const relayout = () => {
    anchors = undefined
    for (const listener of listeners) listener()
  }
  // The line read, as of the last scroll (the anchors are measured once, so
  // this reads no layout after the first scroll).
  let read: number | undefined
  const scrolled = () => {
    read = element.scrollTop > 0 ? lineAt(measure(), element.scrollTop) : undefined
  }
  element.addEventListener('scroll', scrolled, { passive: true })
  // A narrower or wider pane wraps its text anew, and keeps the line read at
  // its top (WebKit has no scroll anchoring to do it).
  const resize = new ResizeObserver(() => {
    anchors = undefined
    if (read !== undefined) element.scrollTop = topOf(measure(), read)
    relayout()
  })
  resize.observe(element)
  element.addEventListener('load', relayout, true)

  return {
    element,
    topLine: () => lineAt(measure(), element.scrollTop),
    offsetOf: (line) => topOf(measure(), line),
    onLayout: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    changed: (count) => {
      if (count !== undefined) lines = count
      relayout()
    },
    dispose: () => {
      resize.disconnect()
      element.removeEventListener('scroll', scrolled)
      element.removeEventListener('load', relayout, true)
      listeners.clear()
    },
  }
}
