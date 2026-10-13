import { invoke } from '../ipc'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { shownAppearance, subscribeAppearance } from '../theme/appearance'
import { createSymbolCache, symbolFor, type Appearance, type IconName } from './symbols'

const cache = createSymbolCache((name, pointSize) =>
  invoke<string>('symbol_png', { name, pointSize }),
)

/** Each size in points, as its `--size-icon-*` token. */
const POINT_SIZES = { sm: 14, md: 17, lg: 22 } as const

/** The appearance the page shows: the one chosen in Settings, else the system's. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribeAppearance, () => shownAppearance())
}

/**
 * An SF Symbol, coloured with the text colour of its parent. Decorative: the
 * control that holds it carries the accessible name.
 */
export function Icon({ name, size }: { name: IconName; size: 'sm' | 'md' | 'lg' }) {
  const appearance = useAppearance()
  const symbol = symbolFor(name)
  const pointSize = POINT_SIZES[size]
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

  const mask = url ? `url("${url}")` : 'none'
  return (
    <span
      className={`icon icon-${size}`}
      data-symbol={symbol}
      aria-hidden="true"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    />
  )
}

/**
 * An SF Symbol as a plain element, for DOM that React does not render (the
 * editor's popups and widgets): masked like `Icon`, its colour the text
 * colour of its parent, at `pointSize` points in the current appearance.
 */
export function iconElement(name: IconName, pointSize: number): HTMLElement {
  const span = document.createElement('span')
  const symbol = symbolFor(name)
  span.className = 'icon'
  span.dataset['symbol'] = symbol
  span.setAttribute('aria-hidden', 'true')
  const appearance: Appearance = matchMedia(DARK).matches ? 'dark' : 'light'
  cache.get(symbol, pointSize, appearance).then(
    (url) => {
      span.style.maskImage = `url("${url}")`
      span.style.setProperty('-webkit-mask-image', `url("${url}")`)
    },
    () => console.warn('W_SYMBOL_UNAVAILABLE', symbol),
  )
  return span
}
