// The note editor's boxed blocks (fenced code and tables) and quote bars
// reach a little past their lines' sides, so the text inside keeps the
// note's column. The editor's content leaves that much room on each side
// (NoteEditor.tsx), so nothing is clipped.

/** How far a box or a quote bar reaches past its line's left and right edges. */
export const BOX_HANG = 'var(--space-2)'
/** Space between a box and the lines above and below it. */
export const BOX_MARGIN = 'var(--space-2)'
/** Space inside a box, between its edge and its first (or last) line. */
export const BOX_PAD = 'var(--space-3)'
