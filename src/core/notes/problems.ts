import type { Live, NoteContext } from './context'

/** The notes whose save failed, as reported to onSaveProblems. */
export function createProblems(ctx: NoteContext) {
  const { options, failing } = ctx
  const report = () => {
    try {
      options.onSaveProblems?.(Array.from(failing, ([id, code]) => ({ id, code })))
    } catch {
      // A listener that throws must not make a write that went through
      // look like one that failed.
    }
  }

  const settle = (note: Live) => {
    note.failures = 0
    clearTimeout(note.retry)
    note.retry = undefined
    if (failing.delete(note.record.id)) report()
  }

  return { report, settle }
}
