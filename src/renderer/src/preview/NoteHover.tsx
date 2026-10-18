// A note link in the preview (a chip or plain link text) shows the note's
// card after the pointer rests on it: its title and the start of its body.
// The card sits over the link (under it when there is no room), kept inside
// the window, and goes when the pointer leaves, a button is pressed or the
// pane scrolls.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { noteIdOf } from '../../../core/links'
import { noteCardDom } from '../noteCard'
import type { LoadPreview, NotePreview } from '../notePreview'
import { sizes } from '../theme/tokens'
import { placeTip, type Box } from '../tipPlacement'

const SHOW_AFTER_MS = Number.parseFloat(sizes['motion.delay.tooltip'])
const LIMITS = {
  gap: Number.parseFloat(sizes['tooltip.gap']),
  edge: Number.parseFloat(sizes['tooltip.edge']),
  arrowInset: Number.parseFloat(sizes['tooltip.arrow-inset']),
}

interface Shown {
  preview: NotePreview | null
  anchor: Box
}

const NOTE_LINKS = 'a[href^="devot://note/"]'

export function NoteHover({
  pane,
  load,
}: {
  pane: RefObject<HTMLElement | null>
  load: LoadPreview
}) {
  const [shown, setShown] = useState<Shown>()
  const card = useRef<HTMLDivElement | null>(null)
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })
  useEffect(() => {
    const root = pane.current
    if (!root) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let over: Element | undefined
    const hide = () => {
      clearTimeout(timer)
      timer = undefined
      over = undefined
      setShown(undefined)
    }
    const enter = (e: PointerEvent) => {
      const link = e.target instanceof Element ? e.target.closest(NOTE_LINKS) : null
      if (link === (over ?? null)) return
      hide()
      const id = link ? noteIdOf(link.getAttribute('href') ?? '') : undefined
      if (!link || !id) return
      over = link
      timer = setTimeout(() => {
        void loadRef
          .current(id)
          .then((preview) => {
            if (over !== link || !link.isConnected) return
            const r = link.getBoundingClientRect()
            setShown({
              preview,
              anchor: { left: r.left, top: r.top, width: r.width, height: r.height },
            })
          })
          .catch(() => undefined)
      }, SHOW_AFTER_MS)
    }
    root.addEventListener('pointerover', enter)
    root.addEventListener('pointerleave', hide)
    root.addEventListener('pointerdown', hide)
    root.addEventListener('scroll', hide)
    return () => {
      hide()
      root.removeEventListener('pointerover', enter)
      root.removeEventListener('pointerleave', hide)
      root.removeEventListener('pointerdown', hide)
      root.removeEventListener('scroll', hide)
    }
  }, [pane])
  // Drawn hidden, measured, then placed and shown, so it never jumps.
  useLayoutEffect(() => {
    const el = card.current
    if (!shown || !el) return
    el.replaceChildren(noteCardDom(shown.preview))
    const placed = placeTip(
      shown.anchor,
      { width: el.offsetWidth, height: el.offsetHeight },
      {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      LIMITS,
    )
    el.style.left = `${placed.left}px`
    el.style.top = `${placed.top}px`
    el.style.setProperty('--tip-arrow-x', `${placed.arrowX}px`)
    el.dataset['side'] = placed.side
    el.style.visibility = 'visible'
  }, [shown])
  if (!shown) return null
  return (
    <div
      ref={card}
      className="tool-tip note-card-pop"
      role="tooltip"
      style={{ visibility: 'hidden' }}
    />
  )
}
