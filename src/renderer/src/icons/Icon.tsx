import { invoke } from '../ipc'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { shownAppearance, subscribeAppearance } from '../theme/appearance'
import {
  createSymbolCache,
  symbolFor,
  symbolStyle,
  type Appearance,
  type IconName,
} from './symbols'

const cache = createSymbolCache((name, pointSize) =>
  invoke<string>('symbol_png', { name, pointSize }),
)

/**
 * Each size's box in pixels, as its `--size-icon-*` token; the symbol is
 * centred on it at `symbolPoints` of it. `xs` is a small mark beside text
 * (a pop-up's chevron, a tag's remove button).
 */
const BOXES = { xs: 10, sm: 14, md: 17, toolbar: 18, lg: 22 } as const

/**
 * The point size a symbol is drawn at for a box: a symbol at N points is
 * a little taller than N pixels (its padding round the glyph), so this
 * keeps a typical one inside the box. One rule for every icon, so all of
 * them share one scale and stroke weight.
 */
export function symbolPoints(box: number): number {
  return Math.round(box * 0.8)
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
 * control that holds it carries the accessible name.
 */
export function Icon({ name, size }: { name: IconName; size: keyof typeof BOXES }) {
  const appearance = useAppearance()
  const symbol = symbolFor(name)
  const pointSize = symbolPoints(BOXES[size])
  const [url, setUrl] = useState<string>()

  useEffect(() => {
    let current = true
    cache.get(symbol, pointSize, appearance).then(
      (next) => current && setUrl(next),
      () => console.warn('W_SYMBOL_UNAVAILABLE', symbol),
    )
    return () => {
      current = false
    }
  }, [symbol, pointSize, appearance])

  return (
    <span
      className={`icon icon-${size}`}
      data-symbol={symbol}
      aria-hidden="true"
      style={url ? symbolStyle(url, BOXES[size]) : { maskImage: 'none', WebkitMaskImage: 'none' }}
    />
  )
}

/**
 * An SF Symbol as a plain element, for DOM that React does not render (the
 * editor's popups and widgets): masked like `Icon`, its colour the text
 * colour of its parent, centred on a `box`-pixel square in the current appearance.
 */
export function iconElement(name: IconName, box: number): HTMLElement {
  const pointSize = symbolPoints(box)
  const span = document.createElement('span')
  const symbol = symbolFor(name)
  span.className = 'icon'
  span.dataset['symbol'] = symbol
  span.setAttribute('aria-hidden', 'true')
  const appearance: Appearance = shownAppearance()
  cache.get(symbol, pointSize, appearance).then(
    (url) => {
      // React's names to CSS's (`WebkitMaskImage` is `-webkit-mask-image`).
      for (const [key, value] of Object.entries(symbolStyle(url, box)))
        span.style.setProperty(
          key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
          value,
        )
    },
    () => console.warn('W_SYMBOL_UNAVAILABLE', symbol),
  )
  return span
}
