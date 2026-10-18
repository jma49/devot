// Messages between the preview and the hidden Mermaid frame. The frame
// announces itself with `ready` through window messaging; the preview answers
// with a private MessagePort, and every request and reply then goes through
// that port only.

export interface RenderRequest {
  type: 'render'
  id: number
  source: string
  appearance: 'light' | 'dark'
  /** The preview's font, so the frame measures text as the preview draws it. */
  fontFamily: string
  fontSize: string
}

/** Sent by the frame to its parent window (not through the port). */
export const READY = 'devot-mermaid-ready'

/**
 * Why the frame could not draw: `parse`, the source has an error (kept until
 * the source changes); `render`, drawing failed for another reason (asked
 * again later).
 */
export type FailureReason = 'parse' | 'render'

export type FrameMessage =
  | { type: 'rendered'; id: number; svg: string }
  | { type: 'failed'; id: number; reason: FailureReason }

/** Diagram sources above this size are refused, not rendered. */
export const MAX_SOURCE_LENGTH = 100_000

export function isRenderRequest(data: unknown): data is RenderRequest {
  const r = data as Partial<RenderRequest> | null
  return (
    typeof r === 'object' &&
    r !== null &&
    r.type === 'render' &&
    Number.isSafeInteger(r.id) &&
    typeof r.source === 'string' &&
    r.source.length <= MAX_SOURCE_LENGTH &&
    (r.appearance === 'light' || r.appearance === 'dark') &&
    typeof r.fontFamily === 'string' &&
    typeof r.fontSize === 'string'
  )
}

export function isFrameMessage(data: unknown): data is FrameMessage {
  const m = data as Partial<{
    type: string
    id: number
    svg: string
    reason: string
  }> | null
  if (typeof m !== 'object' || m === null || !Number.isSafeInteger(m.id)) return false
  if (m.type === 'failed') return m.reason === 'parse' || m.reason === 'render'
  return m.type === 'rendered' && typeof m.svg === 'string'
}

/** postMessage target: the app's own origin (custom schemes may report "null"). */
export function targetOrigin(): string {
  return location.origin === 'null' ? '*' : location.origin
}

const MAX_NAME_LENGTH = 120
const TITLED_KINDS = new Set([
  'pie',
  'gantt',
  'journey',
  'timeline',
  'quadrantChart',
  'xychart',
  'xychart-beta',
])

/**
 * The name the diagram's author gave it: an `accTitle:` line, a `title:` in
 * the front matter, or a `title` line (pie, gantt and others); null when
 * it has none. Screen readers announce it for the drawing.
 */
export function diagramName(source: string): string | null {
  const clean = (value: string | undefined) => {
    const text = (value ?? '')
      .replace(/^["']|["']$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    return text ? text.slice(0, MAX_NAME_LENGTH) : null
  }
  const lines = source.split(/\r?\n/)
  let front = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, n) => n > 0 && line.trim() === '---')
    if (end > 0) front = end + 1
  }
  const find = (pattern: RegExp, from: number, to: number) => {
    for (const line of lines.slice(from, to)) {
      const name = clean(pattern.exec(line)?.[1])
      if (name) return name
    }
    return null
  }
  const first = lines
    .slice(front)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('%%'))
  const kind = first?.match(/^[A-Za-z][\w-]*/)?.[0]
  // `title` is a keyword only in some diagram types; in others it may name a node.
  const titled = kind !== undefined && TITLED_KINDS.has(kind)
  return (
    find(/^\s*accTitle\s*:\s*(.+)$/, front, lines.length) ??
    find(/^\s*title\s*:\s*(.+)$/, 0, front) ??
    (titled
      ? find(/^\s*(?:pie\s+(?:showData\s+)?)?title(?:\s*:\s*|\s+)(.+)$/, front, lines.length)
      : null)
  )
}

/**
 * Gives a drawing one name for assistive technology. Mermaid's own
 * `aria-labelledby` (from `accTitle`) would override `aria-label`, so it goes.
 */
export function labelDiagram(
  svg: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void },
  label: string,
): void {
  svg.removeAttribute('aria-labelledby')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', label)
}
