import { invoke } from '../ipc'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createSymbolCache, symbolFor, type Appearance, type IconName } from './symbols'

const cache = createSymbolCache((name, pointSize) =>
  invoke<string>('symbol_png', { name, pointSize }),
)

const DARK = '(prefers-color-scheme: dark)'

/** Each size in points, as its `--size-icon-*` token. */
const POINT_SIZES = { sm: 14, md: 17, lg: 22 } as const

function subscribe(onChange: () => void) {
  const query = matchMedia(DARK)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(
    subscribe,
    () => (matchMedia(DARK).matches ? 'dark' : 'light'),
    // Rendered outside a window (component tests): the light appearance.
    () => 'light',
  )
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
