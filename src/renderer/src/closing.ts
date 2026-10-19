// Pop-ups close with motion (design/README.md, "Motion"): menus and tooltips
// shrink toward their notch or anchor as they fade, floating bars and
// completion lists only fade. The pop-up itself goes at once, so focus, keys
// and the accessibility tree move on without waiting; a copy of it stays in
// its place, inert and hidden from assistive tech, until its closing
// animation ends (or the animation's length passes, if `animationend` never
// comes). A pop-up that opens again takes over from its fading copy.

export type CloseMotion = 'scale' | 'fade'

export interface ClosingTarget {
  addEventListener(type: string, listener: (event: { target: unknown }) => void): void
  removeEventListener(type: string, listener: (event: { target: unknown }) => void): void
}

const FALLBACK_SLACK_MS = 100

function seconds(time: string): number {
  const value = Number.parseFloat(time)
  if (!Number.isFinite(value)) return 0
  return time.trim().endsWith('ms') ? value : value * 1000
}

/**
 * How long a CSS animation list runs, in ms: the longest duration plus its
 * delay (`getComputedStyle`'s `animationDuration` and `animationDelay`; the
 * delays repeat when there are fewer of them, as in CSS).
 */
export function animationMs(durations: string, delays = ''): number {
  const ds = durations.split(',').filter((d) => d.trim() !== '')
  const ls = delays.split(',').filter((d) => d.trim() !== '')
  let longest = 0
  ds.forEach((d, i) => {
    const delay = ls.length > 0 ? seconds(ls[i % ls.length] ?? '0s') : 0
    longest = Math.max(longest, seconds(d) + delay)
  })
  return longest
}

/**
 * Runs `done` once, when `target`'s own animation ends or is cancelled (not
 * one inside it), or after `fallbackMs`. Returns a function that cancels.
 */
export function whenClosed(target: ClosingTarget, done: () => void, fallbackMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    clearTimeout(timer)
    target.removeEventListener('animationend', onEnd)
    target.removeEventListener('animationcancel', onEnd)
  }
  function onEnd(event: { target: unknown }) {
    if (event.target !== target) return
    stop()
    done()
  }
  target.addEventListener('animationend', onEnd)
  target.addEventListener('animationcancel', onEnd)
  timer = setTimeout(() => {
    stop()
    done()
  }, fallbackMs)
  return stop
}

/** The editor tooltips that fade out when they close (by their classes), or null. The floating bars do not: they vanish with the selection. */
export function tooltipMotion(classes: Iterable<string>): CloseMotion | null {
  const list = new Set(classes)
  if (!list.has('cm-tooltip')) return null
  return list.has('cm-tooltip-autocomplete') ? 'fade' : null
}

function dropClosingCopies(parent: ParentNode | null, kind: string): void {
  for (const copy of closingCopies(parent, kind)) copy.remove()
}

function closingCopies(parent: ParentNode | null, kind: string): HTMLElement[] {
  if (!parent) return []
  return Array.from(parent.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.dataset['closing'] === kind,
  )
}

/**
 * The time, within `durationMs`, at which a rising `valueAt` first reaches
 * `target` (to the millisecond, erring later so the value never falls short).
 */
export function timeReaching(
  target: number,
  valueAt: (ms: number) => number,
  durationMs: number,
): number {
  if (!(durationMs > 0) || valueAt(0) >= target) return 0
  let below = 0
  let reached = durationMs
  while (reached - below > 1) {
    const mid = (below + reached) / 2
    if (valueAt(mid) < target) below = mid
    else reached = mid
  }
  return reached
}

/**
 * Retargets `el`'s entrance from `copy`, the closing copy it replaces: the
 * copy goes and `el`'s CSS animations jump ahead to where its opacity matches
 * the copy's, so a reopen never dips back to transparent.
 */
export function enterFrom(el: Element, copy: Element): void {
  const opacity = Number.parseFloat(getComputedStyle(copy).opacity)
  copy.remove()
  const entrance = el.getAnimations().filter((a) => 'animationName' in a)
  if (entrance.length === 0 || !(opacity > 0)) return
  const end = Math.max(...entrance.map((a) => Number(a.effect?.getComputedTiming().endTime ?? 0)))
  const at = (ms: number) => {
    for (const a of entrance) a.currentTime = ms
    return Number.parseFloat(getComputedStyle(el).opacity)
  }
  at(timeReaching(opacity, at, end))
}

/** Clears the fading copies of `kind` in `parent` as `el` opens there, taking over from the latest. */
export function takeOverClosingCopy(el: Element, parent: ParentNode | null, kind: string): void {
  const copies = closingCopies(parent, kind)
  const latest = copies.pop()
  for (const copy of copies) copy.remove()
  if (latest) enterFrom(el, latest)
}

type ScrollOffsets = [number, number][]

const scrolled = new WeakMap<Element, [number, number]>()

/**
 * Remembers where the elements under `root` are scrolled to, for copies of
 * pop-ups already closed or taken out, whose own offsets then read 0.
 */
export function rememberScrolls(root: Node): () => void {
  const note = (event: Event) => {
    const el = event.target
    if (el instanceof Element) scrolled.set(el, [el.scrollTop, el.scrollLeft])
  }
  root.addEventListener('scroll', note, { capture: true, passive: true })
  return () => root.removeEventListener('scroll', note, { capture: true })
}

export function scrollOffsets(el: Element): ScrollOffsets {
  const shown = el.isConnected && el.getClientRects().length > 0
  return [el, ...Array.from(el.querySelectorAll('*'))].map((e) =>
    shown ? [e.scrollTop, e.scrollLeft] : (scrolled.get(e) ?? [0, 0]),
  )
}

export function restoreScroll(copy: Element, offsets: ScrollOffsets): void {
  ;[copy, ...Array.from(copy.querySelectorAll('*'))].forEach((e, i) => {
    const [top, left] = offsets[i] ?? [0, 0]
    if (top) e.scrollTop = top
    if (left) e.scrollLeft = left
  })
}

/**
 * Leaves a closing copy of `el` where it is, or where it was (`at`, for an
 * element already taken out). `kind` names the pop-up, so one that opens
 * again can take over from its copy. The copy keeps `el`'s classes, so its
 * styles pick the closing animation by `motion` (`data-closing-motion`).
 */
export function leaveClosingCopy(
  el: HTMLElement,
  motion: CloseMotion,
  kind: string,
  at?: { parent: Node; before: Node | null },
): void {
  const parent = at ? at.parent : el.parentNode
  if (!parent?.isConnected || el.dataset['closing'] !== undefined) return
  const offsets = scrollOffsets(el)
  const copy = el.cloneNode(true) as HTMLElement
  // Ids would repeat the pop-up's (a new one may be open with them).
  for (const node of [copy, ...Array.from(copy.querySelectorAll('[id]'))])
    node.removeAttribute('id')
  copy.dataset['closing'] = kind
  copy.dataset['closingMotion'] = motion
  copy.setAttribute('aria-hidden', 'true')
  copy.inert = true
  dropClosingCopies(
    parent instanceof Element || parent instanceof DocumentFragment ? parent : null,
    kind,
  )
  parent.insertBefore(
    copy,
    at ? (at.before?.parentNode === parent ? at.before : null) : el.nextSibling,
  )
  restoreScroll(copy, offsets)
  const style = getComputedStyle(copy)
  const ms = animationMs(style.animationDuration, style.animationDelay)
  if (ms <= 0 || style.animationName === 'none') return copy.remove()
  whenClosed(copy, () => copy.remove(), ms + FALLBACK_SLACK_MS)
}

/**
 * A ref callback for a pop-up that closes with `motion`: on mount it takes
 * over from a fading copy of the same `kind`, on unmount it leaves one. Made
 * once per pop-up (at module level), so React keeps the same callback.
 */
export function closingRef(motion: CloseMotion, kind: string) {
  return (el: HTMLElement | null) => {
    if (!el) return
    takeOverClosingCopy(el, el.parentElement, kind)
    return () => leaveClosingCopy(el, motion, kind)
  }
}
