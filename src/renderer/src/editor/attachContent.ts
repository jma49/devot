import { Facet, type Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/** Images and text a native capture (a scan, a transcription) hands the note at its caret. */
export interface Attachment {
  readonly images: readonly File[]
  readonly text: string
}

/** Stores the images and inserts them, then the text, at the caret; resolves to the codes of images refused. */
export type AttachContent = (view: EditorView, attachment: Attachment) => Promise<readonly string[]>

export const attachContent = Facet.define<AttachContent, AttachContent | null>({
  combine: (values) => values[0] ?? null,
})

/**
 * `markdown` with the line breaks that put it on lines of its own at `pos`: images are blocks, so
 * a scan dropped mid-sentence does not split the sentence's words into its link.
 */
export function asBlockAt(doc: Text, pos: number, markdown: string): string {
  const before = pos > 0 && doc.sliceString(pos - 1, pos) !== '\n' ? '\n' : ''
  const after = pos < doc.length && doc.sliceString(pos, pos + 1) !== '\n' ? '\n' : ''
  return `${before}${markdown}${after}`
}
