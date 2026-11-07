// A boxed block (fenced code, a table) shares the note's text column: its
// outer edge is the padding every line has, where prose starts, and the
// writing inside sits further in. A quote's bar uses that same edge.

/** Space between a box and the lines above and below it. */
export const BOX_MARGIN = 'var(--space-2)'
/** The line's padding, which is also where a box's outer edge sits. */
export const BOX_PAD = 'var(--space-3)'
/** Space between a box's edge and the text inside it. */
export const BOX_INSET = 'var(--space-7)'
