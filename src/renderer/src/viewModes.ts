export type Mode = 'write' | 'edit' | 'split' | 'preview'

/** Write and Edit show the editor alone; Write hides the Markdown marks of the lines without the caret. */
export const editorOnly = (mode: Mode): mode is 'write' | 'edit' =>
  mode === 'write' || mode === 'edit'
