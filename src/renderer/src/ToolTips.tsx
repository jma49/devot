import { useEffect, useState } from 'react'
import { closingRef } from './closing'
import { t } from './i18n'

/** How long the pointer rests on a button before its tooltip shows, in ms. */
const SHOW_AFTER_MS = 600

/** The toolbar buttons whose tooltips show as bubbles. */
const TOOLS = '.toolbar .tool[title], .toolbar .tool[data-tip]'

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

/** A tooltip shrinks back toward its notch as it goes. */
const tipRef = closingRef('scale', 'tool-tip')

interface Shown {
  name: string
  key: string | undefined
  x: number
  y: number
}

/**
 * Tooltips of the panes' toolbar buttons as bubbles: the name, then the key
 * in a chip. While one shows, its button's `title` waits in `data-tip`, so
 * the system tooltip does not show over it; it comes back when the bubble
 * goes (the pointer leaves, a click, a key, a scroll).
 */
export function ToolTips() {
  const [shown, setShown] = useState<Shown>()
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
      target = el
      timer = setTimeout(() => {
        const title = el.getAttribute('title')
        if (!title || !el.isConnected) return
        el.dataset['tip'] = title
        el.removeAttribute('title')
        const box = el.getBoundingClientRect()
        setShown({ ...splitTip(title), x: box.left + box.width / 2, y: box.bottom })
      }, SHOW_AFTER_MS)
    }
    document.addEventListener('pointerover', over)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('keydown', hide, true)
    document.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      hide()
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('keydown', hide, true)
      document.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])
  if (!shown) return null
  return (
    <div ref={tipRef} className="tool-tip" role="tooltip" style={{ left: shown.x, top: shown.y }}>
      <span>{shown.name}</span>
      {shown.key ? <kbd className="tool-tip-key">{shown.key}</kbd> : null}
    </div>
  )
}
