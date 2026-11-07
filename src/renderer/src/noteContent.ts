/** Where a note's content shows (the preview): it changes on every render and holds none of the app's own parts. */
const NOTE_CONTENT = '[data-devot-part="preview"]'

export const inNoteContent = (node: Node): boolean =>
  node instanceof Element && node.closest(NOTE_CONTENT) !== null

/** Whether every record in a batch is a change of nodes inside a note's content. */
export function onlyNoteContent(records: readonly MutationRecord[]): boolean {
  let last: Node | undefined
  for (const record of records) {
    if (record.target === last) continue
    if (record.type !== 'childList' || !inNoteContent(record.target)) return false
    last = record.target
  }
  return true
}
