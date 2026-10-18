import { invoke } from '../ipc'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { shownAppearance, subscribeAppearance } from '../theme/appearance'
import {
  createSymbolCache,
  canvasPixels,
  fitInCanvas,
  renderPoints,
  symbolFor,
  symbolStyle,
  type Appearance,
  type IconName,
  type SymbolImage,
  type SymbolWeight,
} from './symbols'

const cache = createSymbolCache((name, pointSize, weight) =>
  invoke<string>('symbol_png', { name, pointSize, weight }),
)

/**
 * Each size's box in pixels, as its `--size-icon-*` token; the symbol's ink
 * is centred on it (`symbolStyle`). `xs` is a small mark beside text (a
 * pop-up's chevron, a tag's remove button).
 */
const BOXES = { xs: 10, sm: 14, md: 17, toolbar: 18, lg: 22 } as const

/**
 * The point size a symbol is drawn at for a box: a symbol at N points is a
 * little taller than N pixels, so this keeps a typical one inside the box.
 * Every symbol at one size for a box shares its stroke weight.
 */
const boxPoints = (box: number) => Math.round(box * 0.8)

/**
 * Draws a rendered symbol into the one square canvas every symbol of a box
 * shares (`box` x `ratio` device pixels), centred on whole pixels, copied
 * pixel for pixel. It is shown at `box` CSS pixels, so it is never resampled.
 */
async function compose(rendered: string, box: number, ratio: number): Promise<SymbolImage> {
  const whole = { x: 0, y: 0, width: box, height: box }
  const image = new Image()
  image.src = rendered
  await image.decode()
  const side = canvasPixels(box, ratio)
  const canvas = document.createElement('canvas')
  canvas.width = side
  canvas.height = side
  const context = canvas.getContext('2d')
  if (!context) return { url: rendered, width: box, height: box, ink: whole }
  const at = fitInCanvas(image.naturalWidth, image.naturalHeight, side)
  context.drawImage(image, at.x, at.y, at.width, at.height)
  return { url: canvas.toDataURL('image/png'), width: box, height: box, ink: whole }
}

const placed = new Map<string, Promise<SymbolImage>>()

/**
 * A symbol drawn for a box at a device pixel ratio (every symbol at one point
 * size and weight, in one canvas size). Never scaled in the page.
 */
function placedSymbol(
  symbol: string,
  box: number,
  appearance: Appearance,
  ratio: number,
  weight: SymbolWeight = 'regular',
): Promise<SymbolImage> {
  const key = `${symbol}@${box}x${ratio}/${appearance}/${weight}`
  let entry = placed.get(key)
  if (!entry) {
    entry = (async () =>
      compose(
        await cache.get(symbol, renderPoints(boxPoints(box), ratio), appearance, weight),
        box,
        ratio,
      ))()
    entry.catch(() => placed.delete(key))
    placed.set(key, entry)
  }
  return entry
}

/** The window's device pixel ratio; a change (another display) renders the symbols again. */
function subscribeRatio(notify: () => void) {
  const query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}
const currentRatio = () => (typeof devicePixelRatio === 'number' ? devicePixelRatio : 2)

/** The appearance the page shows: the one chosen in Settings, else the system's. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(
    subscribeAppearance,
    () => shownAppearance(),
    // Rendered outside a window (component tests): the light appearance.
    () => 'light',
  )
}

/**
 * An SF Symbol, coloured with the text colour of its parent, at `weight` (regular unless given). Decorative: the
 * control that holds it carries the accessible name.
 */
export function Icon({
  name,
  size,
  weight,
}: {
  name: IconName
  size: IconSize
  /** The stroke weight; regular when left out. */
  weight?: SymbolWeight
}) {
  return <SymbolIcon symbol={symbolFor(name)} size={size} {...(weight ? { weight } : {})} />
}

export type IconSize = keyof typeof BOXES

/**
 * An SF Symbol by its system name (one Devot lists: `symbols.json` or the
 * notebook icon catalog), drawn like `Icon`. `lazy` renders it only once it
 * scrolls into view (a long grid of symbols); `fallback` is drawn instead
 * when the symbol cannot be rendered.
 */
export function SymbolIcon({
  symbol,
  size,
  weight,
  className,
  lazy = false,
  fallback,
}: {
  symbol: string
  size: IconSize
  weight?: SymbolWeight
  /** More classes for the icon (a colour). */
  className?: string
  lazy?: boolean
  fallback?: string
}) {
  const appearance = useAppearance()
  const box = BOXES[size]
  const ratio = useSyncExternalStore(subscribeRatio, currentRatio, () => 2)
  const [image, setImage] = useState<SymbolImage>()
  const span = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(!lazy)

  useEffect(() => {
    if (visible) return
    const el = span.current
    if (!el || typeof IntersectionObserver === 'undefined') return setVisible(true)
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        setVisible(true)
        observer.disconnect()
      },
      // A row ahead, so scrolling shows drawn symbols.
      { rootMargin: `${box * 3}px` },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [visible, box])

  useEffect(() => {
    if (!visible) return
    let current = true
    const show = (next: SymbolImage) => current && setImage(next)
    placedSymbol(symbol, box, appearance, ratio, weight).then(show, () => {
      console.warn('W_SYMBOL_UNAVAILABLE', symbol)
      if (fallback && fallback !== symbol)
        placedSymbol(fallback, box, appearance, ratio, weight).then(show, () =>
          console.warn('W_SYMBOL_UNAVAILABLE', fallback),
        )
    })
    return () => {
      current = false
    }
  }, [visible, symbol, box, appearance, ratio, weight, fallback])

  return (
    <span
      ref={span}
      className={`icon icon-${size}${className ? ` ${className}` : ''}`}
      data-symbol={symbol}
      aria-hidden="true"
      style={image ? symbolStyle(image, box) : { maskImage: 'none', WebkitMaskImage: 'none' }}
    />
  )
}

/**
 * An SF Symbol as a plain element, for DOM that React does not render (the
 * editor's popups and widgets): placed like `Icon` on a `box`-pixel square,
 * its colour the text colour of its parent, in the current appearance.
 */
export function iconElement(name: IconName, box: number): HTMLElement {
  const span = document.createElement('span')
  const symbol = symbolFor(name)
  span.className = 'icon'
  span.dataset['symbol'] = symbol
  span.setAttribute('aria-hidden', 'true')
  placedSymbol(symbol, box, shownAppearance(), currentRatio()).then(
    (image) => {
      // React's names to CSS's (`WebkitMaskImage` is `-webkit-mask-image`).
      for (const [key, value] of Object.entries(symbolStyle(image, box)))
        span.style.setProperty(
          key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
          value,
        )
    },
    () => console.warn('W_SYMBOL_UNAVAILABLE', symbol),
  )
  return span
}
