// The main window's half of quick capture (menu bar mode): the capture
// window hands its note to Rust, which passes it here as an event
// (`devot://quick-capture`) and waits for this window's answer
// (`quick_capture_claim`, `quick_capture_done`), so this window's core is the one that writes the
// library (src-tauri/src/menu_bar.rs).
import { errorCode } from '../../core/errors'
import { NOTE_STATUSES, type NoteStatus } from '../../core/storage'
import { MAX_TAG_NAME_CHARS } from '../../core/tagNames'
import { charCount, trimWhitespace } from '../../core/text'

export const QUICK_CAPTURE_EVENT = 'devot://quick-capture'
const MAX_CAPTURE_TAGS = 50

export interface CaptureRequest {
  id: number
  title: string
  body: string
  bookId: string | null
  status?: NoteStatus
  tags?: string[]
}

function validTag(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = trimWhitespace(value)
  if (!trimmed || /[\r\n]/.test(value) || charCount(trimmed) > MAX_TAG_NAME_CHARS) return null
  return trimmed
}

export function readCaptureRequest(payload: unknown): CaptureRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const { id, title, body, bookId, status, tags } = payload as Record<string, unknown>
  if (
    !Number.isSafeInteger(id) ||
    (id as number) < 0 ||
    typeof title !== 'string' ||
    typeof body !== 'string' ||
    (bookId !== null && typeof bookId !== 'string')
  )
    return null
  let validStatus: NoteStatus | undefined
  if (status !== undefined && status !== null) {
    if (typeof status !== 'string' || !(NOTE_STATUSES as readonly unknown[]).includes(status)) {
      return null
    }
    if (status !== 'none') validStatus = status as NoteStatus
  }
  let validTags: string[] | undefined
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.length > MAX_CAPTURE_TAGS) return null
    const cleaned = tags.map(validTag)
    if (cleaned.some((item) => item === null)) return null
    if (cleaned.length > 0) validTags = cleaned as string[]
  }
  return {
    id: id as number,
    title,
    body,
    bookId,
    ...(validStatus !== undefined ? { status: validStatus } : {}),
    ...(validTags !== undefined ? { tags: validTags } : {}),
  }
}

/**
 * Whether the capture was saved. It is claimed first, so one Rust has given up on is never
 * written; a claimed one is always answered, with a code on failure.
 */
export async function answerCapture(
  request: CaptureRequest,
  claim: (id: number) => Promise<unknown>,
  save: (request: CaptureRequest) => Promise<void>,
  reply: (id: number, error: string | null) => Promise<unknown>,
): Promise<boolean> {
  try {
    await claim(request.id)
  } catch (e) {
    console.warn('W_QUICK_CAPTURE_CLAIM_FAILED', errorCode(e))
    return false
  }
  let error: string | null = null
  try {
    await save(request)
  } catch (e) {
    error = errorCode(e, 'E_QUICK_CAPTURE_FAILED')
  }
  try {
    await reply(request.id, error)
  } catch (e) {
    // Rust gave up waiting after the claim: the capture window says the note may still appear.
    console.warn('W_QUICK_CAPTURE_ANSWER_FAILED', errorCode(e))
  }
  return error === null
}
