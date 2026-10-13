import { invoke } from '../ipc'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { shownAppearance, subscribeAppearance } from '../theme/appearance'
import {
  createSymbolCache,
  fitPoints,
  inkBounds,
  symbolFor,
  symbolSize,
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

/** Reads where a rendered symbol's ink is. */
async function measure(url: string): Promise<SymbolImage> {
  const size = symbolSize(url) ?? { width: 0, height: 0 }
  const image = new Image()
  image.src = url
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  const whole = { x: 0, y: 0, ...size }
  if (!context) return { url, ...size, ink: whole }
  context.drawImage(image, 0, 0)
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
  const alpha = new Uint8ClampedArray(canvas.width * canvas.height)
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3] ?? 0
  return { url, ...size, ink: inkBounds(alpha, canvas.width, canvas.height) ?? whole }
}

const placed = new Map<string, Promise<SymbolImage>>()

/**
 * A symbol rendered for a box, with where its ink is. `fit` (a toolbar's
 * set of buttons): rendered again at the point size that gives its ink the
 * set's size (`fitPoints`). Never scaled in the page.
 */
function placedSymbol(
  symbol: string,
  box: number,
  appearance: Appearance,
  fit: boolean,
): Promise<SymbolImage> {
  const key = `${symbol}@${box}/${appearance}${fit ? '/fit' : ''}`
  let entry = placed.get(key)
  if (!entry) {
    entry = (async () => {
      const points = boxPoints(box)
      const first = await measure(await cache.get(symbol, points, appearance))
      if (!fit) return first
      const fitted = fitPoints(first.ink, points, box)
      return fitted === points ? first : measure(await cache.get(symbol, fitted, appearance))
    })()
    entry.catch(() => placed.delete(key))
    placed.set(key, entry)
  }
  return entry
}

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
 * control that holds it carries the accessible name. `fit`: one of a set of
 * buttons whose symbols are sized to match (see `placedSymbol`).
 */
export function Icon({
  name,
  size,
  fit = false,
}: {
  name: IconName
  size: keyof typeof BOXES
  fit?: boolean
}) {
  const appearance = useAppearance()
  const symbol = symbolFor(name)
  const box = BOXES[size]
  const [image, setImage] = useState<SymbolImage>()

  useEffect(() => {
    let current = true
    placedSymbol(symbol, box, appearance, fit).then(
      (next) => current && setImage(next),
      () => console.warn('W_SYMBOL_UNAVAILABLE', symbol),
    )
    return () => {
      current = false
    }
  }, [symbol, box, appearance, fit])

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
  placedSymbol(symbol, box, shownAppearance(), false).then(
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
