// Drawings of plugins' SVG preview renderers (ADR 0027). The plugin draws in its sandboxed frame and answers SVG
// markup; the page rebuilds it from a fixed list of SVG elements, without scripts, handlers, links or anything that
// would fetch, into a shadow root of its own, so the drawing's stylesheet styles the drawing and nothing else.
// The host is laid out with `contain: paint`, so nothing in the drawing can be drawn outside its box.
// The main window keeps each drawing it shows with the note, and a window without the plugin shows the kept one, rebuilt
// the same way (ADR 0030).
import {
  KEPT_DRAWING_ISLAND,
  PLUGIN_ISLAND,
  PREVIEW_API_VERSION,
} from '../../../core/preview/registry'
import { t } from '../i18n'
import { dark, light, type ThemeColor } from '../theme/tokens'
import { pointsElsewhere, withoutRemoteCss } from './diagram-css'
import type { IslandContent, IslandContext, PreviewIsland } from './islands'
import { keptAnswers } from './kept'
import { findKeptDrawing, keptDrawingsOf, keptDrawingsRevision } from './keptDrawings'
import { EDIT_ATTRIBUTE, editableBlock, setPluginEditor, type PluginEditor } from './pluginEdits'
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

/** Keeps a drawing the page rebuilt, with the block it was drawn from (ADR 0030). */
export type KeepPluginDrawing = (
  noteId: string,
  drawing: { key: string; content: string; appearance: IslandContext['appearance']; svg: string },
) => void

let drawer: DrawPluginBlock | undefined
let keeper: KeepPluginDrawing | undefined

const drawn = keptAnswers<string | null>(64, () => true)
let revision = ''

/**
 * The main window hands its plugin host over here; other windows have none and show the block as code.
 * Drawings are kept by `renderers`, so a plugin updated to another version draws again. Blocks of the renderers in
 * `editable` get an Edit button (ADR 0029).
 */
export function setPluginDrawer(
  draw: DrawPluginBlock | undefined,
  renderers: string,
  edits?: PluginEditor,
  keep?: KeepPluginDrawing,
): void {
  drawer = draw
  keeper = draw ? keep : undefined
  revision = renderers
  setPluginEditor(draw ? edits : undefined)
}

// A blur or a morphology costs with its size squared on each paint; a drawing never needs more than these.
const FILTER_SIZES: Readonly<Record<string, number>> = {
  'feGaussianBlur stdDeviation': 32,
  'feDropShadow stdDeviation': 32,
  'feMorphology radius': 16,
}
/** A CSS filter's functions take any size, so a drawing's CSS has none; its SVG filters are bounded above. */
const CSS_FILTER = /(?:^|[\s;{])(?:-[a-z]+-)?(?:backdrop-)?filter\s*:/i
/** The `filter` attribute takes CSS filter functions too, so it may only name a filter of the drawing. */
const FILTER_REFERENCE = /^\s*(?:none|url\(\s*(['"]?)#[^'"()\s]*\1\s*\))\s*$/i

/** The sizes in `value`, each kept within 0 and `max`; null when one is not a number. */
function filterSize(value: string, max: number): string | null {
  const sizes = value
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (sizes.length > 2 || sizes.some((n) => !Number.isFinite(n))) return null
  return sizes.map((n) => Math.min(Math.max(n, 0), max)).join(' ')
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
      css.push(withoutRemoteCss(source.textContent ?? '', CSS_FILTER))
      return null
    }
    const el = document.createElementNS(SVG_NS, source.localName)
    for (const attr of Array.from(source.attributes)) {
      if (/^on/i.test(attr.localName)) continue
      if (attr.localName === 'style') {
        ;(el as SVGElement).style.cssText = withoutRemoteCss(attr.value, CSS_FILTER)
        continue
      }
      if (attr.localName === 'href' ? !attr.value.startsWith('#') : pointsElsewhere(attr.value))
        continue
      if (attr.localName === 'filter' && !FILTER_REFERENCE.test(attr.value)) continue
      const max = FILTER_SIZES[`${source.localName} ${attr.localName}`]
      const value = max === undefined ? attr.value : filterSize(attr.value, max)
      if (value === null) continue
      if (attr.namespaceURI === XLINK_NS)
        el.setAttributeNS(XLINK_NS, `xlink:${attr.localName}`, value)
      else if (attr.namespaceURI === null) el.setAttribute(attr.localName, value)
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

/** The rebuilt drawing as markup a note keeps: its stylesheet in one `style` element, first. */
export function keptMarkup(svg: SVGSVGElement, css: string): string {
  const copy = svg.cloneNode(true) as SVGSVGElement
  if (css) {
    const style = document.createElementNS(SVG_NS, 'style')
    style.textContent = css
    copy.insertBefore(style, copy.firstChild)
  }
  return new XMLSerializer().serializeToString(copy)
}

function drawingHost(svg: SVGSVGElement, css: string): HTMLElement {
  labelDiagram(svg, t('plugins.drawingLabel'))
  const host = document.createElement('div')
  host.className = 'plugin-drawing'
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.adoptedStyleSheets = css ? [base(), drawingSheet(css)] : [base()]
  shadow.appendChild(svg)
  return host
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

const editableSources = new WeakMap<Node, string>()

async function render(
  source: string,
  { appearance, noteId }: IslandContext,
): Promise<IslandContent> {
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
    if (keeper && noteId)
      keeper(noteId, { key, content: block, appearance, svg: keptMarkup(svg, css) })
    const host = drawingHost(svg, css)
    if (!editableBlock(key)) return { node: host }
    const box = document.createElement('div')
    box.className = 'plugin-drawing-box'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'plugin-drawing-edit'
    button.setAttribute(EDIT_ATTRIBUTE, '')
    button.textContent = t('plugins.drawingEdit')
    box.append(host, button)
    editableSources.set(box, source)
    return {
      node: box,
      update(previous) {
        if (editableSources.get(previous) !== source) return false
        const [shown, edit] = previous.childNodes
        if (
          previous.childNodes.length !== 2 ||
          !(shown instanceof HTMLElement) ||
          !shown.classList.contains('plugin-drawing') ||
          !(edit instanceof HTMLButtonElement) ||
          !edit.hasAttribute(EDIT_ATTRIBUTE)
        )
          return false
        previous.replaceChild(host, shown)
        if (edit.textContent !== button.textContent) edit.textContent = button.textContent
        return true
      },
    }
  } catch {
    console.warn('W_PLUGIN_DRAWING_FAILED', key, 'E_PLUGIN_SVG')
    return failed(false)
  }
}

function keptAsCode(block: string): IslandContent {
  const box = document.createElement('div')
  box.className = 'kept-drawing-code'
  const note = document.createElement('div')
  note.className = 'kept-drawing-note'
  note.textContent = t('plugins.drawingKeptStale')
  box.append(asCode(block).node, note)
  return { node: box }
}

/** A kept drawing, never inserted as it came: rebuilt as a live one is, without an Edit button. */
async function renderKept(
  source: string,
  { appearance, noteId }: IslandContext,
): Promise<IslandContent> {
  const first = source.indexOf('\n')
  const second = source.indexOf('\n', first + 1)
  const block = second > first && first > 0 ? source.slice(second + 1) : ''
  const kept = noteId ? keptDrawingsOf(noteId) : undefined
  const drawing =
    kept && second > first && first > 0
      ? findKeptDrawing(kept, {
          language: source.slice(0, first),
          hash: source.slice(first + 1, second),
          appearance,
        })
      : undefined
  if (!drawing) return keptAsCode(block)
  try {
    const { svg, css } = importPluginSvg(drawing.svg)
    return { node: drawingHost(svg, css) }
  } catch {
    console.warn('W_KEPT_DRAWING_REFUSED', 'E_PLUGIN_SVG')
    return keptAsCode(block)
  }
}

export const keptDrawingIsland: PreviewIsland = {
  kind: KEPT_DRAWING_ISLAND,
  apiVersion: PREVIEW_API_VERSION,
  revision: (context) => keptDrawingsRevision(context.noteId),
  render: renderKept,
}

export const pluginIsland: PreviewIsland = {
  kind: PLUGIN_ISLAND,
  apiVersion: PREVIEW_API_VERSION,
  revision: () => revision,
  render,
}
