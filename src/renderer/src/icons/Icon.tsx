import { invoke } from '../ipc'
import { localStore } from '../localStore'
import { version } from '../../../../package.json'
import type { IconStyleChoice } from '../../../core/editorSettings'
import { editorSettings, useEditorSetting } from '../editorSettings'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { shownAppearance, subscribeAppearance } from '../theme/appearance'
import type { LucideIcon } from 'lucide-react'
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
import { keptSymbols } from './keptSymbols'

const cache = createSymbolCache((name, pointSize, weight) =>
  invoke<string>('symbol_png', { name, pointSize, weight }),
)

const BOXES = {
  xs: 10,
  sm: 14,
  md: 17,
  toolbar: 18,
  'phone-status': 20,
  'phone-toast': 19,
  'phone-compose': 24,
  'phone-tab': 25,
  'phone-row': 21,
  lg: 22,
  title: 17,
} as const

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

// The module's URL names the bundle it came in, whose hash changes with any build of the UI; the
// version covers a release whose Rust renders symbols differently. The dev server's never changes.
const kept = keptSymbols(
  import.meta.env.DEV ? () => undefined : localStore,
  `${version} ${import.meta.url}`,
)
const placed = new Map<string, Promise<SymbolImage>>()
const drawn = new Map<string, SymbolImage>(kept.images)

const placedKey = (
  symbol: string,
  box: number,
  appearance: Appearance,
  ratio: number,
  weight: SymbolWeight = 'regular',
  title = false,
) => `${symbol}@${box}x${ratio}/${appearance}/${weight}/${title}`

/** `keep` keeps the image for the next launches: the window's own icons, not a catalog's. */
function placedSymbol(
  symbol: string,
  box: number,
  appearance: Appearance,
  ratio: number,
  weight: SymbolWeight = 'regular',
  title = false,
  keep = false,
): Promise<SymbolImage> {
  const key = placedKey(symbol, box, appearance, ratio, weight, title)
  const ready = drawn.get(key)
  if (ready) return Promise.resolve(ready)
  let entry = placed.get(key)
  if (!entry) {
    entry = (async () =>
      compose(
        await cache.get(symbol, renderPoints(boxPoints(box), ratio), appearance, weight),
        box,
        ratio,
        title,
      ))()
    entry.then(
      (image) => {
        drawn.set(key, image)
        if (keep) kept.keep(key, image)
      },
      () => placed.delete(key),
    )
    placed.set(key, entry)
  }
  return entry
}

// One query for every icon, made again for each new ratio, since it matches the ratio it was made for.
const ratioListeners = new Set<() => void>()
let ratioQuery: MediaQueryList | undefined

function watchRatio() {
  ratioQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
  ratioQuery.addEventListener('change', ratioChanged, { once: true })
}

function ratioChanged() {
  watchRatio()
  for (const notify of ratioListeners) notify()
}

function subscribeRatio(notify: () => void) {
  ratioListeners.add(notify)
  if (!ratioQuery) watchRatio()
  return () => {
    ratioListeners.delete(notify)
    if (ratioListeners.size > 0) return
    ratioQuery?.removeEventListener('change', ratioChanged)
    ratioQuery = undefined
  }
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

let notebookGlyphs: Readonly<Record<string, LucideIcon>> | undefined
let notebookGlyphsLoading: Promise<Readonly<Record<string, LucideIcon>>> | undefined

export function loadNotebookGlyphs() {
  notebookGlyphsLoading ??= import('./lucideNotebook').then(
    (module) => (notebookGlyphs = module.NOTEBOOK_LUCIDE_GLYPHS),
    (error: unknown) => {
      notebookGlyphsLoading = undefined
      throw error
    },
  )
  return notebookGlyphsLoading
}

/** A glyph of the notebook icon catalog, loaded on demand; like a symbol, it paints nothing until it is in. */
export function NotebookLucideIcon({
  glyph,
  size,
  className,
}: {
  glyph: string
  size: IconSize
  className?: string
}) {
  const [glyphs, setGlyphs] = useState(notebookGlyphs)
  useEffect(() => {
    if (glyphs) return
    let current = true
    loadNotebookGlyphs().then(
      (loaded) => current && setGlyphs(loaded),
      () => console.warn('W_LUCIDE_NOTEBOOK_UNAVAILABLE'),
    )
    return () => {
      current = false
    }
  }, [glyphs])
  const Glyph = glyphs?.[glyph]
  const classes = `icon-${size}${className ? ` ${className}` : ''}`
  if (!Glyph)
    return (
      <span className={`icon ${classes}`} data-lucide={glyph} data-pending="" aria-hidden="true" />
    )
  return (
    <Glyph
      size={BOXES[size]}
      strokeWidth={lucideStroke(size === 'title' ? 'light' : 'regular')}
      className={`icon-svg ${classes}`}
      data-lucide={glyph}
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

/** A toolbar button's icon: smaller and lighter, at one size for buttons and segments. */
export function ToolIcon({ name }: { name: IconName }) {
  return <Icon name={name} size="toolbar" weight="light" />
}

export type IconSize = keyof typeof BOXES

/** Renders `symbols` ahead of showing them, so they draw in their first frame; a symbol that fails is only retried when shown. */
export function preloadSymbols(symbols: readonly string[], size: IconSize) {
  for (const symbol of symbols)
    placedSymbol(symbol, BOXES[size], shownAppearance(), currentRatio()).catch(() => {})
}

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
  const ready = drawn.get(placedKey(symbol, box, appearance, ratio, weight, size === 'title'))
  const painted = ready ?? image
  // Read once: an icon that mounted already drawn must not fade in later.
  const [arrives] = useState(ready === undefined)
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
    const title = size === 'title'
    placedSymbol(symbol, box, appearance, ratio, weight, title, !lazy).then(show, () => {
      console.warn('W_SYMBOL_UNAVAILABLE', symbol)
      if (fallback && fallback !== symbol)
        placedSymbol(fallback, box, appearance, ratio, weight, title, !lazy).then(show, () =>
          console.warn('W_SYMBOL_UNAVAILABLE', fallback),
        )
    })
    return () => {
      current = false
    }
  }, [visible, symbol, box, appearance, ratio, weight, fallback, size, lazy])

  return (
    <span
      ref={span}
      className={`icon icon-${size}${className ? ` ${className}` : ''}`}
      data-symbol={symbol}
      data-pending={painted ? undefined : ''}
      data-arrives={arrives ? '' : undefined}
      aria-hidden="true"
      style={painted ? symbolStyle(painted) : undefined}
    />
  )
}

interface LucideData {
  name: string
  aliases?: unknown[]
  node: [tag: string, attributes: Record<string, string>][]
}

const attributeText = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The markup React's server renderer gives `<Glyph size={size} className={className} />`, without
 * that renderer in the startup bundle (issue 742).
 */
export function lucideMarkup(Glyph: LucideIcon, size: number, className: string): string {
  // A Lucide icon is a forwardRef whose render only hands its data to Lucide's own Icon element.
  const { icon } = (
    Glyph as unknown as { render: (props: object, ref: null) => { props: { icon: LucideData } } }
  ).render({}, null).props
  const children = icon.node
    .map(([tag, attributes]) => {
      const text = Object.entries(attributes)
        .filter(([key]) => key !== 'key')
        .map(([key, value]) => ` ${key}="${attributeText(String(value))}"`)
        .join('')
      return `<${tag}${text}></${tag}>`
    })
    .join('')
  const names = [icon.name, ...(icon.aliases ?? [])].filter(
    (name): name is string => typeof name === 'string' && name.trim() !== '',
  )
  const classes = [
    ...new Set(['lucide', ...names.map((name) => `lucide-${name}`), ...className.split(' ')]),
  ]
    .filter(Boolean)
    .join(' ')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${classes}" aria-hidden="true">${children}</svg>`
}

export function iconElement(name: IconName, box: number): HTMLElement {
  const span = document.createElement('span')
  if (editorSettings().iconStyle === 'lucide') {
    const Glyph = LUCIDE_ICONS[name]
    const fill = LUCIDE_FILLS[name]
    span.className = 'icon-host'
    span.innerHTML = lucideMarkup(Glyph, box, `icon-svg${fill ? ` icon-fill-${fill}` : ''}`)
    return span
  }
  const symbol = symbolFor(name)
  span.className = 'icon'
  span.style.width = `${box}px`
  span.style.height = `${box}px`
  span.dataset['symbol'] = symbol
  span.dataset['pending'] = ''
  span.setAttribute('aria-hidden', 'true')
  placedSymbol(symbol, box, shownAppearance(), currentRatio(), 'regular', false, true).then(
    (image) => {
      delete span.dataset['pending']
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
