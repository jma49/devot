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
  const m = data as Partial<{ type: string; id: number; svg: string; reason: string }> | null
  if (typeof m !== 'object' || m === null || !Number.isSafeInteger(m.id)) return false
  if (m.type === 'failed') return m.reason === 'parse' || m.reason === 'render'
  return m.type === 'rendered' && typeof m.svg === 'string'
}

/** postMessage target: the app's own origin (custom schemes may report "null"). */
export function targetOrigin(): string {
  return location.origin === 'null' ? '*' : location.origin
}
