// When a floating bar over the editor shows. The selection toolbar, the
// image size bar and a code block's copy button follow one rule: they show
// only while the editor has the keyboard focus (each adds what it is for: a
// selection, an image at the caret, the caret in a block), fade in over
// `motion.duration.fade` (motion.ts `fadeIn`) and hide at once.
import type { EditorState } from '@codemirror/state'
import { editorFocused } from './toolbarState'

export const barsMayShow = (state: EditorState): boolean => editorFocused(state)
