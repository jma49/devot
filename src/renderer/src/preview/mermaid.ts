// Mermaid diagrams. Mermaid runs in a hidden same-origin frame
// (mermaid.html): it needs a real page to measure text, and its libraries
// assign to prototypes, which fails in this window, where Object.prototype is
// frozen. The frame is created on the first diagram. Its SVG is rebuilt here
// node by node under the strict CSP: the embedded <style> becomes a
// constructed stylesheet and `style` attributes go through the CSSOM, so no
// inline style is ever parsed. Scripts, event handlers, foreign objects and
// external links are dropped.
import { PREVIEW_API_VERSION } from '../../../core/preview/registry'
import { t } from '../i18n'
import type { IslandContent, IslandContext, PreviewIsland } from './islands'
import {
  isFrameMessage,
  MAX_SOURCE_LENGTH,
  READY,
  targetOrigin,
  type FailureReason,
  type FrameMessage,
  type RenderRequest,
} from './mermaid-protocol'

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const DROPPED = new Set(['script', 'foreignObject', 'iframe', 'image', 'use'])

/** A request the frame does not answer in time shows the error box. */
const TIMEOUT_MS = 10_000
/** How long the frame may take to load, before its first request is sent. */
const LOAD_TIMEOUT_MS = 30_000

let frame: HTMLIFrameElement | undefined
/** The current port to the frame; replaced whenever the frame (re)loads. */
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

/** The port to the hidden renderer frame, created on the first diagram. */
function rendererPort(): Promise<MessagePort> {
  if (!frame) {
    const element = document.createElement('iframe')
    frame = element
    element.className = 'mermaid-frame'
    element.setAttribute('aria-hidden', 'true')
    element.tabIndex = -1
    window.addEventListener('message', (event) => {
      if (event.data !== READY || event.source !== element.contentWindow) return
      if (event.origin !== location.origin && location.origin !== 'null') return
      const channel = new MessageChannel()
      channel.port1.onmessage = onReply
      element.contentWindow?.postMessage(READY, targetOrigin(), [channel.port2])
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

/** The frame's answer, or the parent's own when the frame does not answer. */
type Answer =
  | { type: 'rendered'; svg: string }
  | { type: 'failed'; reason: FailureReason | 'timeout' }

/** One request at a time; the next is sent when the frame has answered. */
let queue: Promise<unknown> = Promise.resolve()

function renderInFrame(source: string, appearance: IslandContext['appearance']): Promise<Answer> {
  const turn = queue.then(() => ask(source, appearance))
  queue = turn
  return turn
}

/**
 * Sends one request. Its time limit starts when it is sent: a frame that is
 * still loading has a limit of its own, so a slow start is not taken for a
 * failed drawing.
 */
function ask(source: string, appearance: IslandContext['appearance']): Promise<Answer> {
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
        const preview = document.querySelector('.preview') ?? document.body
        const font = getComputedStyle(preview)
        const request: RenderRequest = {
          type: 'render',
          id,
          source,
          appearance,
          fontFamily: font.fontFamily,
          fontSize: font.fontSize,
        }
        target.postMessage(request)
      },
      () => answer({ type: 'failed', reason: 'render' }),
    )
  })
}

/** Copies a parsed SVG into the page, applying styles through the CSSOM. */
export function importSvg(markup: string): { svg: SVGSVGElement; css: string } {
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml')
  const root = parsed.documentElement
  if (root.localName !== 'svg' || root.namespaceURI !== SVG_NS) throw new Error('E_MERMAID_SVG')
  const css: string[] = []

  const copy = (source: Element): Element | null => {
    if (source.namespaceURI !== SVG_NS || DROPPED.has(source.localName)) return null
    if (source.localName === 'style') {
      css.push(source.textContent ?? '')
      return null
    }
    const el = document.createElementNS(SVG_NS, source.localName)
    for (const attr of Array.from(source.attributes)) {
      if (/^on/i.test(attr.localName)) continue
      if (attr.localName === 'style') {
        ;(el as SVGElement).style.cssText = attr.value
        continue
      }
      if (attr.localName === 'href' && !attr.value.startsWith('#')) continue
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

function adopt(css: string): () => void {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  return () => {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet)
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
  if (reason === 'parse') {
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

/** Logs a failure that is not an error in the source (codes only). */
function logFailure(reason: FailureReason | 'timeout' | 'svg'): void {
  if (reason !== 'parse') console.warn('W_MERMAID_FAILED', reason)
}

async function render(source: string, { appearance }: IslandContext): Promise<IslandContent> {
  if (source.length > MAX_SOURCE_LENGTH) return errorContent('parse')
  const answer = await renderInFrame(source, appearance)
  if (answer.type !== 'rendered') {
    logFailure(answer.reason)
    return errorContent(answer.reason)
  }
  try {
    const { svg, css } = importSvg(answer.svg)
    svg.setAttribute('role', 'img')
    return { node: svg, dispose: adopt(css) }
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
export async function mermaidMarkup(source: string): Promise<string | null> {
  if (source.length > MAX_SOURCE_LENGTH) return null
  const answer = await renderInFrame(source, 'light')
  if (answer.type !== 'rendered') {
    logFailure(answer.reason)
    return null
  }
  try {
    const { svg, css } = importSvg(answer.svg)
    svg.setAttribute('role', 'img')
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
  render,
}
