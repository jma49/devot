import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react'
import { motionReduced } from './motionPreference'
import { springTiming, type SpringToken } from './motionTiming'

const SEGMENTS = ':scope > .segment:not(.segment-thumb)'
const THUMB = ':scope > .segment-thumb'
const DRAG_START_PX = 3

export const thumbTransform = (x: number, lift: number): string =>
  `translateX(${x}px) scale(${lift})`

/** The segment under `x`, from the left edges of the segments. */
export function segmentAt(lefts: readonly number[], width: number, x: number): number {
  const centre = x + width / 2
  let found = 0
  lefts.forEach((left, i) => {
    if (centre >= left) found = i
  })
  return found
}

const segmentsOf = (group: HTMLElement) => Array.from(group.querySelectorAll<HTMLElement>(SEGMENTS))

const liftScale = (group: HTMLElement) =>
  Number.parseFloat(getComputedStyle(group).getPropertyValue('--segment-lift')) || 1

function thumbOf(group: HTMLElement, at: HTMLElement): HTMLElement {
  group.dataset['sliding'] = ''
  const existing = group.querySelector<HTMLElement>(THUMB)
  if (existing) return existing
  const thumb = document.createElement('span')
  thumb.className = 'segment segment-thumb'
  thumb.setAttribute('aria-pressed', 'true')
  thumb.setAttribute('aria-hidden', 'true')
  thumb.style.left = '0'
  thumb.style.top = `${at.offsetTop}px`
  thumb.style.width = `${at.offsetWidth}px`
  thumb.style.height = `${at.offsetHeight}px`
  thumb.style.transform = thumbTransform(at.offsetLeft, 1)
  group.append(thumb)
  return thumb
}

// A control that remounts on the change starts its thumb where the old one was dropped.
let carried: { x: number; lift: number } | null = null

const drawn = (thumb: HTMLElement) => {
  const m = new DOMMatrixReadOnly(getComputedStyle(thumb).transform)
  return { x: m.m41, lift: m.m11 }
}

function moveThumb(
  thumb: HTMLElement,
  x: number,
  lift: number,
  spring: SpringToken,
  width = thumb.offsetWidth,
): Animation {
  const from = drawn(thumb)
  const fromWidth = thumb.offsetWidth
  for (const animation of thumb.getAnimations()) animation.cancel()
  const to = thumbTransform(x, lift)
  thumb.style.transform = to
  thumb.style.width = `${width}px`
  return thumb.animate(
    [
      { transform: thumbTransform(from.x, from.lift), width: `${fromWidth}px` },
      { transform: to, width: `${width}px` },
    ],
    springTiming(spring),
  )
}

function settle(group: HTMLElement, thumb: HTMLElement, target: HTMLElement): void {
  const done = () => {
    if (!thumb.isConnected || thumb.dataset['held'] !== undefined) return
    thumb.remove()
    delete group.dataset['sliding']
  }
  const animation = moveThumb(thumb, target.offsetLeft, 1, 'settle', target.offsetWidth)
  animation.addEventListener('finish', done)
}

function dropThumb(group: HTMLElement): void {
  group.querySelector(THUMB)?.remove()
  delete group.dataset['sliding']
}

/**
 * The pressed look moves at once (final state first). While it travels or is
 * held, a `.segment` copy in the pressed state draws it, so every control's
 * own pressed style applies without a thumb element of its own.
 */
function slideThumb(group: HTMLElement, from: number, to: number): void {
  if (motionReduced() || typeof group.animate !== 'function') return dropThumb(group)
  const segments = segmentsOf(group)
  const start = segments[from]
  const target = segments[to]
  if (!start || !target) return
  const thumb = thumbOf(group, start)
  if (carried) thumb.style.transform = thumbTransform(carried.x, carried.lift)
  carried = null
  delete thumb.dataset['held']
  settle(group, thumb, target)
}

function watchThumbDrag(group: HTMLElement): () => void {
  let held: { id: number; startX: number; baseX: number; moved: boolean } | null = null
  let dragClick = false
  const down = (event: PointerEvent) => {
    dragClick = false
    carried = null
    if (event.button !== 0 || motionReduced() || typeof group.animate !== 'function') return
    const on = (event.target as Element).closest<HTMLElement>('.segment')
    if (!on || on.getAttribute('aria-pressed') !== 'true' || on.parentElement !== group) return
    if (on.hasAttribute('disabled')) return
    const thumb = thumbOf(group, on)
    thumb.dataset['held'] = ''
    group.setPointerCapture(event.pointerId)
    held = { id: event.pointerId, startX: event.clientX, baseX: on.offsetLeft, moved: false }
    moveThumb(thumb, on.offsetLeft, liftScale(group), 'lift')
  }
  const move = (event: PointerEvent) => {
    if (held?.id !== event.pointerId) return
    const thumb = group.querySelector<HTMLElement>(THUMB)
    if (!thumb) return
    const dx = event.clientX - held.startX
    if (!held.moved) {
      if (Math.abs(dx) < DRAG_START_PX) return
      held.moved = true
    }
    const segments = segmentsOf(group)
    const last = segments.at(-1)
    if (!last) return
    const x = Math.min(last.offsetLeft, Math.max(segments[0]!.offsetLeft, held.baseX + dx))
    for (const animation of thumb.getAnimations()) animation.cancel()
    thumb.style.transform = thumbTransform(x, liftScale(group))
  }
  const up = (event: PointerEvent) => {
    if (held?.id !== event.pointerId) return
    const { moved } = held
    held = null
    const thumb = group.querySelector<HTMLElement>(THUMB)
    if (!thumb) return
    delete thumb.dataset['held']
    const segments = segmentsOf(group)
    const pressed = segments.findIndex((s) => s.getAttribute('aria-pressed') === 'true')
    const at = drawn(thumb)
    const index =
      moved && event.type === 'pointerup'
        ? segmentAt(
            segments.map((s) => s.offsetLeft),
            thumb.offsetWidth,
            at.x,
          )
        : pressed
    const target = segments[index]
    if (!target) return dropThumb(group)
    dragClick = moved
    if (index !== pressed) {
      carried = at
      target.click()
    }
    settle(group, thumb, target)
  }
  // The browser's own click after a drag lands on whatever is under the pointer, which may not be
  // the segment the thumb was dropped on.
  const click = (event: MouseEvent) => {
    if (!dragClick || !event.isTrusted) return
    dragClick = false
    event.stopPropagation()
  }
  group.addEventListener('click', click, true)
  group.addEventListener('pointerdown', down)
  group.addEventListener('pointermove', move)
  group.addEventListener('pointerup', up)
  group.addEventListener('pointercancel', up)
  return () => {
    group.removeEventListener('click', click, true)
    group.removeEventListener('pointerdown', down)
    group.removeEventListener('pointermove', move)
    group.removeEventListener('pointerup', up)
    group.removeEventListener('pointercancel', up)
    dropThumb(group)
  }
}

/** Slides the pressed look of a `.segmented` group to `selected`, and lets the pointer drag it there. `from` gives the index a newly mounted control comes from. */
export function useSegmentSlide(
  group: RefObject<HTMLElement | null>,
  selected: number,
  from?: RefObject<number>,
): void {
  const own = useRef(selected)
  const seen = from ?? own
  useLayoutEffect(() => {
    const before = seen.current
    seen.current = selected
    if (group.current && before >= 0 && before !== selected)
      slideThumb(group.current, before, selected)
  }, [group, seen, selected])
  const watching = useRef<{ el: HTMLElement; stop: () => void } | null>(null)
  // The group may mount after the control does (a section still loading).
  useEffect(() => {
    const el = group.current
    if (watching.current?.el === el) return
    watching.current?.stop()
    watching.current = el ? { el, stop: watchThumbDrag(el) } : null
  })
  useEffect(
    () => () => {
      watching.current?.stop()
      watching.current = null
    },
    [],
  )
}
