// The main window's half of quick capture (menu bar mode): the capture
// window hands its note to Rust, which passes it here as an event
// (`devot://quick-capture`) and waits for this window's answer
// (`quick_capture_done`), so this window's core is the one that writes the
// library (src-tauri/src/menu_bar.rs).
import { errorCode } from '../../core/errors'

export const QUICK_CAPTURE_EVENT = 'devot://quick-capture'

export interface CaptureRequest {
  id: number
  title: string
  body: string
  bookId: string | null
}

export function readCaptureRequest(payload: unknown): CaptureRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const { id, title, body, bookId } = payload as Record<string, unknown>
  if (
    !Number.isSafeInteger(id) ||
    (id as number) < 0 ||
    typeof title !== 'string' ||
    typeof body !== 'string' ||
    (bookId !== null && typeof bookId !== 'string')
  )
    return null
  return { id: id as number, title, body, bookId }
}

/** Whether the capture was saved; its answer always goes back, a code on failure. */
export async function answerCapture(
  request: CaptureRequest,
  save: (request: CaptureRequest) => Promise<void>,
  reply: (id: number, error: string | null) => Promise<unknown>,
): Promise<boolean> {
  let error: string | null = null
  try {
    await save(request)
  } catch (e) {
    error = errorCode(e, 'E_QUICK_CAPTURE_FAILED')
  }
  try {
    await reply(request.id, error)
  } catch (e) {
    // Rust gave up waiting: the capture window shows a timeout, the note is made all the same.
    console.warn('W_QUICK_CAPTURE_ANSWER_FAILED', errorCode(e))
  }
  return error === null
}
