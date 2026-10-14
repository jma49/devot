import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { closingRef } from './closing'
import { t } from './i18n'
import { sizes } from './theme/tokens'
import { placeTip, type Box } from './tipPlacement'

/** How long the pointer rests on a button before its tooltip shows (`motion.delay.tooltip`), in ms. */
export const SHOW_AFTER_MS = Number.parseFloat(sizes['motion.delay.tooltip'])

/** Every icon or command button with a tooltip shows it as a bubble. */
const TOOLS = 'button[title], button[data-tip]'

const LIMITS = {
  gap: Number.parseFloat(sizes['tooltip.gap']),
  edge: Number.parseFloat(sizes['tooltip.edge']),
  arrowInset: Number.parseFloat(sizes['tooltip.arrow-inset']),
}

/**
 * A tooltip split into the command's name and its key, as `titleWithKey`
 * wrote it ("New Note (⌘N)"); a title with no key is a name alone.
 */
export function splitTip(title: string): { name: string; key: string | undefined } {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const template = t('shortcut.titleWithKey')
  const pattern = escape(template)
    .replace(escape('{title}'), '(?<name>.+)')
    .replace(escape('{key}'), '(?<key>.+?)')
  const found = new RegExp(`^${pattern}$`, 's').exec(title)
  const name = found?.groups?.['name']
  const key = found?.groups?.['key']
  return name !== undefined && key !== undefined ? { name, key } : { name: title, key: undefined }
}

/** A tooltip fades out as it goes. */
const closeRef = closingRef('fade', 'tool-tip')

interface Shown {
  name: string
  key: string | undefined
  anchor: Box
}

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

/**
 * Tooltips of icon and command buttons as bubbles: the name, then the key in
 * a chip, above the button with a notch (below when there is no room), kept
 * inside the window. A button's `title` moves to `data-tip` as the pointer
 * enters it, so the system tooltip never shows beside the bubble (the button
 * keeps its name as `aria-label`); it comes back when the pointer leaves or
 * presses. The bubble follows its button through scroll and resize.
 */
export function ToolTips() {
  const [shown, setShown] = useState<Shown>()
  const tipEl = useRef<HTMLDivElement | null>(null)
  const bubbleRef = useCallback((el: HTMLDivElement | null) => {
    tipEl.current = el
    return closeRef(el)
  }, [])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let target: HTMLElement | undefined
    const hide = () => {
      clearTimeout(timer)
      timer = undefined
      if (target?.dataset['tip'] !== undefined) {
        target.setAttribute('title', target.dataset['tip'])
        delete target.dataset['tip']
      }
      target = undefined
      setShown(undefined)
    }
    const over = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target.closest<HTMLElement>(TOOLS) : null
      if (el === target) return
      hide()
      if (!el) return
      const title = el.getAttribute('title')
      if (!title) return
      target = el
      if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', title)
      el.dataset['tip'] = title
      el.removeAttribute('title')
      timer = setTimeout(() => {
        if (!el.isConnected) return hide()
        setShown({ ...splitTip(title), anchor: boxOf(el) })
      }, SHOW_AFTER_MS)
    }
    const follow = () => {
      if (!target) return
      if (!target.isConnected) return hide()
      const anchor = boxOf(target)
      setShown((s) => (s ? { ...s, anchor } : s))
    }
    const leave = (e: PointerEvent) => {
      if (e.relatedTarget === null) hide()
    }
    document.addEventListener('pointerover', over)
    document.addEventListener('pointerout', leave)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    window.addEventListener('blur', hide)
    return () => {
      hide()
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerout', leave)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
      window.removeEventListener('blur', hide)
    }
  }, [])
  // The bubble is drawn hidden, measured, then placed and shown, so it never jumps.
  useLayoutEffect(() => {
    const el = tipEl.current
    if (!shown || !el) return
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
    <div ref={bubbleRef} className="tool-tip" role="tooltip" style={{ visibility: 'hidden' }}>
      <span>{shown.name}</span>
      {shown.key ? <kbd className="tool-tip-key">{shown.key}</kbd> : null}
    </div>
  )
}
