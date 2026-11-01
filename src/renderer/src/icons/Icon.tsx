import { renderToStaticMarkup } from 'react-dom/server'
import { invoke } from '../ipc'
import type { IconStyleChoice } from '../../../core/editorSettings'
import { editorSettings, useEditorSetting } from '../editorSettings'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { shownAppearance, subscribeAppearance } from '../theme/appearance'
import { LUCIDE_FILLS, LUCIDE_ICONS, lucideStroke } from './lucide'
import {
  boxPoints,
  createSymbolCache,
  inkBounds,
  placeInCanvas,
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

const BOXES = { xs: 10, sm: 14, md: 17, toolbar: 18, lg: 22, title: 17 } as const

async function compose(
  rendered: string,
  box: number,
  ratio: number,
  title: boolean,
): Promise<SymbolImage> {
  const image = new Image()
  image.src = rendered
  await image.decode()
  const { naturalWidth: width, naturalHeight: height } = image
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('E_SYMBOL_CANVAS_UNAVAILABLE')
  context.drawImage(image, 0, 0)
  const ink = inkBounds(context.getImageData(0, 0, width, height).data, width, height)
  const at = placeInCanvas(ink ?? { x: 0, y: 0, width, height }, box, ratio, title)
  canvas.width = at.side
  canvas.height = at.side
  context.drawImage(image, at.x, at.y, width * at.scale, height * at.scale)
  return { url: canvas.toDataURL('image/png'), side: at.side / ratio }
}

const placed = new Map<string, Promise<SymbolImage>>()

function placedSymbol(
  symbol: string,
  box: number,
  appearance: Appearance,
  ratio: number,
  weight: SymbolWeight = 'regular',
  title = false,
): Promise<SymbolImage> {
  const key = `${symbol}@${box}x${ratio}/${appearance}/${weight}/${title}`
  let entry = placed.get(key)
  if (!entry) {
    entry = (async () =>
      compose(
        await cache.get(symbol, renderPoints(boxPoints(box), ratio), appearance, weight),
        box,
        ratio,
        title,
      ))()
    entry.catch(() => placed.delete(key))
    placed.set(key, entry)
  }
  return entry
}

function subscribeRatio(notify: () => void) {
  const query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}
const currentRatio = () => (typeof devicePixelRatio === 'number' ? devicePixelRatio : 2)

export function useAppearance(): Appearance {
  return useSyncExternalStore(
    subscribeAppearance,
    () => shownAppearance(),
    // Rendered outside a window (component tests): the light appearance.
    () => 'light',
  )
}

function LucideGlyph({
  name,
  size,
  weight,
  className,
}: {
  name: IconName
  size: IconSize
  weight?: SymbolWeight | undefined
  className?: string | undefined
}) {
  const Glyph = LUCIDE_ICONS[name]
  const fill = LUCIDE_FILLS[name]
  return (
    <Glyph
      size={BOXES[size]}
      strokeWidth={lucideStroke(weight ?? (size === 'title' ? 'light' : 'regular'))}
      className={`icon-svg icon-${size}${fill ? ` icon-fill-${fill}` : ''}${className ? ` ${className}` : ''}`}
    />
  )
}

/** Drawn in `style`, whatever the icon-style setting is (the Appearance settings' samples). */
export function StyledIcon({
  style,
  name,
  size,
  weight,
  className,
}: {
  style: IconStyleChoice
  name: IconName
  size: IconSize
  weight?: SymbolWeight
  className?: string
}) {
  if (style === 'lucide')
    return <LucideGlyph name={name} size={size} weight={weight} className={className} />
  return (
    <SymbolIcon
      symbol={symbolFor(name)}
      size={size}
      {...(weight ? { weight } : {})}
      {...(className ? { className } : {})}
    />
  )
}

/** Drawn in the chosen icon style (Settings > Appearance); `className` reaches the SF Symbol's span or the Lucide SVG. */
export function Icon(props: {
  name: IconName
  size: IconSize
  weight?: SymbolWeight
  className?: string
}) {
  return <StyledIcon style={useEditorSetting('iconStyle')} {...props} />
}

/** A toolbar button's icon: the Glass interface draws it smaller and lighter, at one size for buttons and segments. */
export function ToolIcon({ name, size = 'lg' }: { name: IconName; size?: IconSize }) {
  return useEditorSetting('sidebarMaterial') ? (
    <Icon name={name} size="toolbar" weight="light" />
  ) : (
    <Icon name={name} size={size} />
  )
}

export type IconSize = keyof typeof BOXES

/** `lazy` renders only once it scrolls into view (a long grid of symbols); `fallback` is drawn when the symbol cannot be rendered. */
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
    placedSymbol(symbol, box, appearance, ratio, weight, size === 'title').then(show, () => {
      console.warn('W_SYMBOL_UNAVAILABLE', symbol)
      if (fallback && fallback !== symbol)
        placedSymbol(fallback, box, appearance, ratio, weight, size === 'title').then(show, () =>
          console.warn('W_SYMBOL_UNAVAILABLE', fallback),
        )
    })
    return () => {
      current = false
    }
  }, [visible, symbol, box, appearance, ratio, weight, fallback, size])

  return (
    <span
      ref={span}
      className={`icon icon-${size}${className ? ` ${className}` : ''}`}
      data-symbol={symbol}
      aria-hidden="true"
      style={image ? symbolStyle(image) : { maskImage: 'none', WebkitMaskImage: 'none' }}
    />
  )
}

export function iconElement(name: IconName, box: number): HTMLElement {
  const span = document.createElement('span')
  if (editorSettings().iconStyle === 'lucide') {
    const Glyph = LUCIDE_ICONS[name]
    const fill = LUCIDE_FILLS[name]
    span.className = 'icon-host'
    span.innerHTML = renderToStaticMarkup(
      <Glyph size={box} className={`icon-svg${fill ? ` icon-fill-${fill}` : ''}`} />,
    )
    return span
  }
  const symbol = symbolFor(name)
  span.className = 'icon'
  span.style.width = `${box}px`
  span.style.height = `${box}px`
  span.dataset['symbol'] = symbol
  span.setAttribute('aria-hidden', 'true')
  placedSymbol(symbol, box, shownAppearance(), currentRatio()).then(
    (image) => {
      // React's names to CSS's (`WebkitMaskImage` is `-webkit-mask-image`).
      for (const [key, value] of Object.entries(symbolStyle(image)))
        span.style.setProperty(
          key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
          value,
        )
    },
    () => console.warn('W_SYMBOL_UNAVAILABLE', symbol),
  )
  return span
}
