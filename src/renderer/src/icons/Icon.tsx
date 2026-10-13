import { invoke } from '../ipc'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createSymbolCache, symbolFor, type Appearance, type IconName } from './symbols'

const cache = createSymbolCache((name, pointSize) =>
  invoke<string>('symbol_png', { name, pointSize }),
)

const DARK = '(prefers-color-scheme: dark)'

function subscribe(onChange: () => void) {
  const query = matchMedia(DARK)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, () => (matchMedia(DARK).matches ? 'dark' : 'light'))
}

/**
 * An SF Symbol, coloured with the text colour of its parent. Decorative: the
 * control that holds it carries the accessible name.
 */
export function Icon({ name, size }: { name: IconName; size: 'sm' | 'md' }) {
  const appearance = useAppearance()
  const symbol = symbolFor(name)
  const pointSize = size === 'sm' ? 14 : 17
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
