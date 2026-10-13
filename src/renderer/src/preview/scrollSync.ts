// Synced scrolling in split mode: the editor and the preview show the same
// place in the note. Both panes speak in source lines (fractional, 1-based):
// the editor knows its lines; the preview knows the line each block starts on
// (`data-source-line`, set by the core) and interpolates between blocks.
// Scrolling one pane moves the other once per frame. A pane's scroll that
// Devot made itself is never taken for the user's, so nothing echoes back.
// Only the frame callback reads layout, and the preview measures its blocks
// once per layout, so scrolling a long note stays cheap.

/** A block of the preview: its source line and its offset in the scrolled content. */
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
    // A block on the first line is where that line shows.
    if (out.length === 1 && anchor.line === 1 && anchor.top >= 0) out[0] = anchor
    else if (anchor.line > last.line && anchor.top > last.top) out.push(anchor)
  }
  return out
}

/** The pair of anchors around `value` (by `key`), clamped to the ends. */
function around(anchors: readonly Anchor[], key: keyof Anchor, value: number) {
  let lo = 0
  let hi = anchors.length - 1
  // The last anchor at or before `value`.
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (anchors[mid]![key] <= value) lo = mid
    else hi = mid - 1
  }
  return { a: anchors[lo]!, b: anchors[Math.min(lo + 1, anchors.length - 1)]! }
}

/** The offset in the content where `line` shows. */
export function topOf(anchors: readonly Anchor[], line: number): number {
  const first = anchors[0]!
  const last = anchors[anchors.length - 1]!
  if (line <= first.line) return first.top
  if (line >= last.line) return last.top
  const { a, b } = around(anchors, 'line', line)
  if (b.line === a.line) return a.top
  return a.top + ((line - a.line) / (b.line - a.line)) * (b.top - a.top)
}

/** The line that shows at `top` in the content. */
export function lineAt(anchors: readonly Anchor[], top: number): number {
  const first = anchors[0]!
  const last = anchors[anchors.length - 1]!
  if (top <= first.top) return first.line
  if (top >= last.top) return last.line
  const { a, b } = around(anchors, 'top', top)
  if (b.top === a.top) return a.line
  return a.line + ((top - a.top) / (b.top - a.top)) * (b.line - a.line)
}

/** What synced scrolling needs from a scrolled element. */
export interface Scroller extends EventTarget {
  scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

/** A pane that scrolls by source line. */
export interface ScrollPane {
  /** The element that scrolls (its `scroll` events drive the other pane). */
  readonly element: Scroller
  /** The (fractional) source line at the top of the pane. */
  topLine(): number
  /** The scroll offset that puts `line` at the top of the pane. */
  offsetOf(line: number): number
  /** Calls `listener` when the content was laid out anew (a render); returns a stop function. */
  onLayout?(listener: () => void): () => void
}

export interface SyncOptions {
  /** The pane that leads at the start: the editor (`first`) unless the preview was being read. */
  lead?: 'first' | 'second'
  frame?: (run: () => void) => number
  cancel?: (handle: number) => void
  now?: () => number
}

/**
 * Scroll gestures, which show the pane the user is scrolling. (A click or a
 * key does not: it may scroll nothing, while the other pane scrolls for a
 * reason of its own, such as find.)
 */
const GESTURES = ['wheel', 'touchstart'] as const
/** Input that shows the pane the user works in, without scrolling it. */
const WORK = ['keydown', 'pointerdown'] as const
/** How long a pane keeps the lead after a scroll gesture in it. */
const GESTURE_HOLD_MS = 500

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
  /** The offset Devot set on a pane and has not yet seen its scroll event for. */
  const expected = new Map<ScrollPane, number>()
  let gesture: { pane: ScrollPane; at: number } | undefined
  /** The pane the user last scrolled or worked in. */
  let current = lead === 'first' ? first : second
  let leader: ScrollPane | undefined
  /** The follower was laid out anew: it lines up with the leader whatever it reports. */
  let relayout = false
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
  function follow() {
    handle = undefined
    const from = leader
    leader = undefined
    relayout = false
    // A pane that cannot scroll says nothing about where the user is.
    if (!from || maxOffset(from.element) < 1) return
    const to = other(from)
    const target = to.element
    const before = target.scrollTop
    target.scrollTop = followOffset(from, to)
    const after = target.scrollTop
    if (after !== before) expected.set(to, after)
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
  const listen = (target: Scroller, type: string, listener: () => void, capture = false) => {
    target.addEventListener(type, listener, { passive: true, capture })
    stops.push(() => target.removeEventListener(type, listener, { capture }))
  }
  for (const pane of [first, second]) {
    listen(pane.element, 'scroll', onScroll(pane))
    const scrolled = () => {
      gesture = { pane, at: now() }
      current = pane
    }
    for (const type of GESTURES) listen(pane.element, type, scrolled, true)
    for (const type of WORK) listen(pane.element, type, () => (current = pane), true)
    // A pane laid out anew keeps its place while the user works in it.
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

/** The preview as a scroll pane. */
export interface PreviewScrollPane extends ScrollPane {
  /** The preview's layout changed: a new rendering (of a text of `lines` lines) or a diagram. */
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

  /** The layout changed: measure again, and let the panes line up. */
  const relayout = () => {
    anchors = undefined
    for (const listener of listeners) listener()
  }
  // A narrower or wider pane wraps its text anew.
  const resize = new ResizeObserver(relayout)
  resize.observe(element)
  // Images change the layout when they load.
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
      element.removeEventListener('load', relayout, true)
      listeners.clear()
    },
  }
}
