// Drawings of plugins' SVG preview renderers (ADR 0027). The plugin draws in its sandboxed frame and answers SVG
// markup; the page rebuilds it from a fixed list of SVG elements, without scripts, handlers, links or anything that
// would fetch, into a shadow root of its own, so the drawing's stylesheet styles the drawing and nothing else.
// The host is laid out with `contain: paint`, so nothing in the drawing can be drawn outside its box.
import { PLUGIN_ISLAND } from '../../../core/preview'
import { PREVIEW_API_VERSION } from '../../../core/preview/registry'
import { t } from '../i18n'
import { dark, light, type ThemeColor } from '../theme/tokens'
import { pointsElsewhere, withoutRemoteCss } from './diagram-css'
import type { IslandContent, IslandContext, PreviewIsland } from './islands'
import { keptAnswers } from './kept'
import { labelDiagram } from './mermaid-protocol'
import { diagramPalette, type DiagramPalette } from './mermaid-theme'
import { parseColor, toHex } from '../theme/contrast'

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

const ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'style',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'pattern',
  'marker',
  'symbol',
  'filter',
  'feBlend',
  'feColorMatrix',
  'feComponentTransfer',
  'feComposite',
  'feDropShadow',
  'feFlood',
  'feFuncA',
  'feFuncB',
  'feFuncG',
  'feFuncR',
  'feGaussianBlur',
  'feMerge',
  'feMergeNode',
  'feMorphology',
  'feOffset',
])

/** What a plugin is told about the theme a drawing goes on: hex colours by stable name, not by token. */
export interface DrawingTheme {
  appearance: IslandContext['appearance']
  colors: Readonly<Record<keyof DiagramPalette, string>>
}

export type DrawPluginBlock = (
  key: string,
  source: string,
  theme: DrawingTheme,
) => Promise<string | null>

let drawer: DrawPluginBlock | undefined

const drawn = keptAnswers<string | null>(64, () => true)
let revision = ''

/**
 * The main window hands its plugin host over here; other windows have none and show the block as code.
 * Drawings are kept by `renderers`, so a plugin updated to another version draws again.
 */
export function setPluginDrawer(draw: DrawPluginBlock | undefined, renderers: string): void {
  drawer = draw
  revision = renderers
}

/** Rebuilds a plugin's SVG from the elements and attributes it may have; throws `E_PLUGIN_SVG` when it is not SVG. */
export function importPluginSvg(markup: string): { svg: SVGSVGElement; css: string } {
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml')
  const root = parsed.documentElement
  if (root.localName !== 'svg' || root.namespaceURI !== SVG_NS) throw new Error('E_PLUGIN_SVG')
  const css: string[] = []
  const copy = (source: Element): Element | null => {
    if (source.namespaceURI !== SVG_NS || !ELEMENTS.has(source.localName)) return null
    if (source.localName === 'style') {
      css.push(withoutRemoteCss(source.textContent ?? ''))
      return null
    }
    const el = document.createElementNS(SVG_NS, source.localName)
    for (const attr of Array.from(source.attributes)) {
      if (/^on/i.test(attr.localName)) continue
      if (attr.localName === 'style') {
        ;(el as SVGElement).style.cssText = withoutRemoteCss(attr.value)
        continue
      }
      if (attr.localName === 'href' ? !attr.value.startsWith('#') : pointsElsewhere(attr.value))
        continue
      if (attr.namespaceURI === XLINK_NS)
        el.setAttributeNS(XLINK_NS, `xlink:${attr.localName}`, attr.value)
      else if (attr.namespaceURI === null) el.setAttribute(attr.localName, attr.value)
    }
    for (const child of Array.from(source.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE)
        el.appendChild(document.createTextNode(child.nodeValue ?? ''))
      else if (child instanceof Element) {
        const next = copy(child)
        if (next) el.appendChild(next)
      }
    }
    return el
  }
  const svg = copy(root)
  if (!(svg instanceof SVGSVGElement)) throw new Error('E_PLUGIN_SVG')
  return { svg, css: css.join('\n') }
}

/** `:host` would reach the element the drawing sits in, outside the drawing. */
function drawingSheet(css: string): CSSStyleSheet {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  for (let i = sheet.cssRules.length - 1; i >= 0; i -= 1) {
    if (/:host/i.test(sheet.cssRules[i]!.cssText)) sheet.deleteRule(i)
  }
  return sheet
}

let baseSheet: CSSStyleSheet | undefined

function base(): CSSStyleSheet {
  baseSheet ??= drawingSheet(
    'svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }',
  )
  return baseSheet
}

function shownTheme(appearance: IslandContext['appearance']): DrawingTheme {
  const style = getComputedStyle(document.documentElement)
  const fallback = appearance === 'dark' ? dark : light
  const palette = diagramPalette(
    (token: ThemeColor) =>
      style.getPropertyValue(`--${token.replaceAll('.', '-')}`).trim() || fallback[token],
  )
  const colors = Object.fromEntries(
    Object.entries(palette).map(([name, value]) => {
      const { rgb, alpha } = parseColor(value)
      return [name, toHex(rgb, alpha)]
    }),
  ) as DrawingTheme['colors']
  return { appearance, colors }
}

function asCode(source: string): IslandContent {
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  code.textContent = source
  pre.appendChild(code)
  return { node: pre }
}

function failed(retry: boolean): IslandContent {
  const box = document.createElement('div')
  box.className = 'island-error'
  box.setAttribute('role', 'note')
  box.textContent = t('plugins.drawingFailed')
  return retry ? { node: box, retry } : { node: box }
}

async function render(source: string, { appearance }: IslandContext): Promise<IslandContent> {
  const at = source.indexOf('\n')
  const key = at > 0 ? source.slice(0, at) : ''
  const block = at > 0 ? source.slice(at + 1) : source
  const draw = drawer
  if (!draw || !key) return asCode(block)
  const theme = shownTheme(appearance)
  let markup: string | null
  try {
    markup = await drawn(JSON.stringify([revision, key, theme, block]), () =>
      draw(key, block, theme),
    )
  } catch {
    console.warn('W_PLUGIN_DRAWING_FAILED', key)
    return failed(true)
  }
  if (markup === null) return asCode(block)
  try {
    const { svg, css } = importPluginSvg(markup)
    labelDiagram(svg, t('plugins.drawingLabel'))
    const host = document.createElement('div')
    host.className = 'plugin-drawing'
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.adoptedStyleSheets = css ? [base(), drawingSheet(css)] : [base()]
    shadow.appendChild(svg)
    return { node: host }
  } catch {
    console.warn('W_PLUGIN_DRAWING_FAILED', key, 'E_PLUGIN_SVG')
    return failed(false)
  }
}

export const pluginIsland: PreviewIsland = {
  kind: PLUGIN_ISLAND,
  apiVersion: PREVIEW_API_VERSION,
  render,
}
