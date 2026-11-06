// Mermaid diagrams. Mermaid runs in a hidden sandboxed frame (mermaid.html):
// it needs a real page to measure text, and its libraries assign to
// prototypes, which fails in this window, where Object.prototype is frozen.
// The sandbox gives the frame an opaque origin, so it cannot reach this
// window or its IPC. The frame is created on the first diagram. Its SVG is rebuilt here
// node by node under the strict CSP: the embedded <style> becomes a
// constructed stylesheet and `style` attributes go through the CSSOM, so no
// inline style is ever parsed. Scripts, event handlers, foreign objects,
// external links and CSS that would fetch are dropped.
import { PREVIEW_API_VERSION } from '../../../core/preview/registry'
import { format as fill, t } from '../i18n'
import { dark, light, sizes, type ThemeColor } from '../theme/tokens'
import { pointsElsewhere, withoutRemoteCss } from './diagram-css'
import type { IslandContent, IslandContext, PreviewIsland } from './islands'
import { keptAnswers } from './kept'
import {
  diagramName,
  followsWidth,
  isFrameMessage,
  labelDiagram,
  MAX_SOURCE_LENGTH,
  READY,
  type DiagramKind,
  type FailureReason,
  type FrameMessage,
  type RenderRequest,
} from './mermaid-protocol'
import { diagramPalette, exportPalette, type DiagramPalette } from './mermaid-theme'

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const DROPPED = new Set(['script', 'foreignObject', 'iframe', 'image', 'use'])

/** Scripts only: without `allow-same-origin` the frame's origin is opaque. */
export const MERMAID_FRAME_SANDBOX = 'allow-scripts'
const FRAME_ORIGIN = 'null'

const TIMEOUT_MS = 10_000
const LOAD_TIMEOUT_MS = 30_000

let frame: HTMLIFrameElement | undefined
let port: Promise<MessagePort> | undefined
let connect: ((port: MessagePort) => void) | undefined
let counter = 0
const waiting = new Map<number, (message: FrameMessage) => void>()

function onReply(event: MessageEvent): void {
  const message = event.data as unknown
  if (!isFrameMessage(message)) return
  waiting.get(message.id)?.(message)
  waiting.delete(message.id)
}

function rendererPort(): Promise<MessagePort> {
  if (!frame) {
    const element = document.createElement('iframe')
    frame = element
    element.className = 'mermaid-frame'
    element.setAttribute('aria-hidden', 'true')
    element.tabIndex = -1
    element.setAttribute('sandbox', MERMAID_FRAME_SANDBOX)
    window.addEventListener('message', (event) => {
      if (event.data !== READY || event.source !== element.contentWindow) return
      if (event.origin !== FRAME_ORIGIN) return
      const channel = new MessageChannel()
      channel.port1.onmessage = onReply
      // An opaque origin cannot be named as a target; the port goes only to this frame's window.
      element.contentWindow?.postMessage(READY, '*', [channel.port2])
      if (connect) {
        connect(channel.port1)
        connect = undefined
      } else {
        port = Promise.resolve(channel.port1)
      }
    })
    port = new Promise((resolve) => (connect = resolve))
    element.src = new URL('mermaid.html', location.href).href
    document.body.appendChild(element)
  }
  return port ?? Promise.reject(new Error('E_MERMAID_FRAME'))
}

type Answer =
  | { type: 'rendered'; svg: string }
  | { type: 'failed'; reason: FailureReason | 'timeout' }
  /** Not sent: a newer render for its element came first. */
  | { type: 'skipped' }

let queue: Promise<unknown> = Promise.resolve()

interface Font {
  fontFamily: string
  fontSize: string
}

/** Diagrams use the UI font everywhere: a drawing measured in another font would not fit its boxes. */
export function diagramFont(): Font {
  return { fontFamily: sizes['font.family.ui'], fontSize: sizes['font.size.footnote'] }
}

/** The tokens as they are now, in the appearance and theme on screen. */
function shownPalette(appearance: IslandContext['appearance']): DiagramPalette {
  const style = getComputedStyle(document.documentElement)
  const fallback = appearance === 'dark' ? dark : light
  return diagramPalette(
    (token: ThemeColor) =>
      style.getPropertyValue(`--${token.replaceAll('.', '-')}`).trim() || fallback[token],
  )
}

/** A diagram drawn once for a theme and font is not drawn again. */
const drawn = keptAnswers<Answer>(
  64,
  (answer) =>
    answer.type === 'rendered' ||
    (answer.type === 'failed' && (answer.reason === 'parse' || answer.reason === 'layout')),
)

/**
 * Requests wait in one queue for the frame; one whose signal is aborted by
 * the time its turn comes is not sent, so typing in a diagram draws only the
 * latest source instead of every keystroke's.
 */
async function renderInFrame(
  source: string,
  appearance: IslandContext['appearance'],
  palette: DiagramPalette,
  signal?: AbortSignal,
  width?: number,
  kind: DiagramKind = 'mermaid',
): Promise<Answer> {
  const font = diagramFont()
  for (;;) {
    const answer = await drawn(
      JSON.stringify([kind, appearance, palette, font.fontFamily, font.fontSize, width, source]),
      () => {
        const turn = queue.then((): Answer | Promise<Answer> =>
          signal?.aborted
            ? { type: 'skipped' }
            : ask(source, appearance, palette, font, width, kind),
        )
        queue = turn
        return turn
      },
    )
    // A skipped answer may have been shared with a request still wanted: ask again.
    if (answer.type !== 'skipped' || signal?.aborted) return answer
  }
}

/**
 * Sends one request. Its time limit starts when it is sent: a frame that is
 * still loading has a limit of its own, so a slow start is not taken for a
 * failed drawing.
 */
function ask(
  source: string,
  appearance: IslandContext['appearance'],
  palette: DiagramPalette,
  font: Font,
  width?: number,
  kind: DiagramKind = 'mermaid',
): Promise<Answer> {
  const id = (counter += 1)
  return new Promise<Answer>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const answer = (result: Answer) => {
      if (!waiting.delete(id)) return
      clearTimeout(timer)
      resolve(result)
    }
    const expire = () => answer({ type: 'failed', reason: 'timeout' })
    waiting.set(id, (message) =>
      answer(message.type === 'rendered' ? message : { type: 'failed', reason: message.reason }),
    )
    timer = setTimeout(expire, LOAD_TIMEOUT_MS)
    rendererPort().then(
      (target) => {
        if (!waiting.has(id)) return
        clearTimeout(timer)
        timer = setTimeout(expire, TIMEOUT_MS)
        const request: RenderRequest = {
          type: 'render',
          kind,
          id,
          source,
          appearance,
          palette,
          ...font,
          ...(width === undefined ? {} : { width }),
        }
        target.postMessage(request)
      },
      () => answer({ type: 'failed', reason: 'render' }),
    )
  })
}

export function importSvg(markup: string): { svg: SVGSVGElement; css: string } {
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml')
  const root = parsed.documentElement
  if (root.localName !== 'svg' || root.namespaceURI !== SVG_NS) throw new Error('E_MERMAID_SVG')
  const css: string[] = []

  const copy = (source: Element): Element | null => {
    if (source.namespaceURI !== SVG_NS || DROPPED.has(source.localName)) return null
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
  if (!(svg instanceof SVGSVGElement)) throw new Error('E_MERMAID_SVG')
  return { svg, css: css.join('\n') }
}

function adopt(css: string, root: DocumentOrShadowRoot = document): () => void {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
  return () => {
    root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet)
  }
}

/**
 * The box shown in place of a diagram. An error in the source, or a drawing
 * that cannot be read (it would come back the same), stays until the source
 * changes; a failure that may pass (`render`, `timeout`) is drawn again at
 * the next mount, and only its message says so.
 */
function errorContent(reason: FailureReason | 'timeout' | 'svg'): IslandContent {
  const box = document.createElement('div')
  box.className = 'island-error'
  box.setAttribute('role', 'note')
  if (reason === 'parse' || reason === 'layout') {
    box.textContent = t('mermaid.error')
    return { node: box }
  }
  if (reason === 'svg') {
    box.textContent = t('mermaid.cannotDraw')
    return { node: box }
  }
  box.textContent = t('mermaid.unavailable')
  return { node: box, retry: true }
}

function logFailure(reason: FailureReason | 'timeout' | 'svg'): void {
  if (reason !== 'parse') console.warn('W_MERMAID_FAILED', reason)
}

function diagramLabel(source: string): string {
  const name = diagramName(source)
  return name ? fill(t('mermaid.labelNamed'), { name }) : t('mermaid.label')
}

async function render(
  source: string,
  { appearance, signal, width, styleRoot }: IslandContext,
  kind: DiagramKind = 'mermaid',
): Promise<IslandContent> {
  if (source.length > MAX_SOURCE_LENGTH) return errorContent('parse')
  const answer = await renderInFrame(
    source,
    appearance,
    shownPalette(appearance),
    signal,
    width,
    kind,
  )
  if (answer.type === 'skipped') return { node: document.createTextNode('') }
  if (answer.type !== 'rendered') {
    logFailure(answer.reason)
    return errorContent(answer.reason)
  }
  try {
    const { svg, css } = importSvg(answer.svg)
    labelDiagram(svg, diagramLabel(source))
    return { node: svg, dispose: adopt(css, styleRoot) }
  } catch {
    logFailure('svg')
    return errorContent('svg')
  }
}

/**
 * A diagram drawn for an exported or printed page (always light): SVG
 * markup with its styles inside it, cleaned as for the preview; null when
 * it cannot be drawn.
 */
export async function diagramMarkup(kind: DiagramKind, source: string): Promise<string | null> {
  if (source.length > MAX_SOURCE_LENGTH) return null
  const answer = await renderInFrame(source, 'light', exportPalette, undefined, undefined, kind)
  if (answer.type === 'skipped') return null
  if (answer.type !== 'rendered') {
    logFailure(answer.reason)
    return null
  }
  try {
    const { svg, css } = importSvg(answer.svg)
    labelDiagram(svg, diagramLabel(source))
    if (css) {
      const style = document.createElementNS(SVG_NS, 'style')
      style.textContent = css
      svg.prepend(style)
    }
    return new XMLSerializer().serializeToString(svg)
  } catch {
    logFailure('svg')
    return null
  }
}

export const mermaidIsland: PreviewIsland = {
  kind: 'mermaid',
  apiVersion: PREVIEW_API_VERSION,
  followsWidth,
  render,
}

export const mermaidMarkup = (source: string): Promise<string | null> =>
  diagramMarkup('mermaid', source)

export const plantumlIsland: PreviewIsland = {
  kind: 'plantuml',
  apiVersion: PREVIEW_API_VERSION,
  render: (source, context) => render(source, context, 'plantuml'),
}

export const markmapIsland: PreviewIsland = {
  kind: 'markmap',
  apiVersion: PREVIEW_API_VERSION,
  render: (source, context) => render(source, context, 'markmap'),
}
