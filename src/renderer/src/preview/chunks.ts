/**
 * The note's top-level nodes sit in chunks, runs of about `CHUNK_BLOCKS` blocks that each get a
 * composited layer (content.css). WebKit repaints a layer's whole event region after any paint in
 * it, and the page's wheel listeners make that pass walk every block of the layer, so on one layer
 * a keystroke walked the whole preview below the scroll position (issue 727).
 */
export const CHUNK_CLASS = 'preview-chunk'
export const CHUNK_BLOCKS = 100
