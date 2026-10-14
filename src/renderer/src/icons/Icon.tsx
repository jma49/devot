import { invoke } from '../ipc'
import { useEffect, useState, useSyncExternalStore } from 'react'
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
} from './symbols'

const cache = createSymbolCache((name, pointSize) =>
  invoke<string>('symbol_png', { name, pointSize }),
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
): Promise<SymbolImage> {
  const key = `${symbol}@${box}x${ratio}/${appearance}`
  let entry = placed.get(key)
  if (!entry) {
    entry = (async () =>
      compose(
        await cache.get(symbol, renderPoints(boxPoints(box), ratio), appearance),
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
 * An SF Symbol, coloured with the text colour of its parent. Decorative: the
 * control that holds it carries the accessible name.
 */
export function Icon({ name, size }: { name: IconName; size: keyof typeof BOXES }) {
  const appearance = useAppearance()
  const symbol = symbolFor(name)
  const box = BOXES[size]
  const ratio = useSyncExternalStore(subscribeRatio, currentRatio, () => 2)
  const [image, setImage] = useState<SymbolImage>()

  useEffect(() => {
    let current = true
    placedSymbol(symbol, box, appearance, ratio).then(
      (next) => current && setImage(next),
      () => console.warn('W_SYMBOL_UNAVAILABLE', symbol),
    )
    return () => {
      current = false
    }
  }, [symbol, box, appearance, ratio])

  return (
    <span
      className={`icon icon-${size}`}
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
