import { errorCode } from '../../../core/errors'

/** Handles the core refusing an edit to a shown note: each one is reported, each code logged once. */
export function refusedEdits(
  noteId: string,
  report: (noteId: string, code: string) => void,
): (error: unknown) => void {
  const logged = new Set<string>()
  return (error) => {
    const code = errorCode(error)
    if (!logged.has(code)) {
      logged.add(code)
      console.warn('W_NOTE_EDIT_REFUSED', noteId, code)
    }
    report(noteId, code)
  }
}
