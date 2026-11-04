import { EditorView, tooltips } from '@codemirror/view'
import { BOX_PAD } from './boxes'

/**
 * The editor lives in a shadow root: CodeMirror adds its styles there as constructed stylesheets, which the production CSP allows (in the document it would add <style> tags, which the CSP blocks). Theme variables inherit into it.
 */
export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'var(--color-text-editor)',
  },
  '.cm-scroller': {
    fontSize: 'var(--editor-font-size, var(--font-size-body))',
    fontFamily: 'var(--editor-font-family, var(--font-family-mono))',
    fontWeight: 'var(--editor-font-weight, normal)',
    lineHeight: 'var(--editor-line-height, 1.5)',
  },
  '&.cm-focused': { outline: 'none' },
  // The line's padding is the note's text column, and a box sits on it (editor/boxes.ts).
  '.cm-content': {
    '--box-edge': BOX_PAD,
    fontKerning: 'normal',
    lineBreak: 'strict',
  },
  '@supports (text-autospace: normal)': {
    '.cm-content': { textAutospace: 'normal' },
    '.cm-line.cm-codeblock, .cm-md-code': { textAutospace: 'no-autospace' },
  },
  // CodeMirror pads a line 6px on the start side and 2px on the end, and sizes
  // every full row from the first line's padding. Equal sides keep that row on
  // the note's column, which is where a box's outer edge sits (editor/boxes.ts).
  // Each line reads in the direction of its own first strong character (see `perLineTextDirection`).
  '.cm-line': { paddingInline: BOX_PAD, unicodeBidi: 'plaintext' },
  '.cm-scroller::-webkit-scrollbar': {
    width: 'var(--size-scrollbar)',
    height: 'var(--size-scrollbar)',
    background: 'transparent',
  },
  '.cm-scroller::-webkit-scrollbar-thumb': {
    borderRadius: 'var(--radius-capsule)',
    background: 'var(--color-fill-scrollbar)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--color-editor-caret)',
    borderLeftWidth: 'var(--space-1)',
  },
  '.cm-placeholder': { color: 'var(--color-editor-placeholder)' },
  // CodeMirror's own colours are for a light page; these follow the tokens,
  // so the gutter, the active line and the selection read in both appearances.
  // The pane behind is a translucent wash, so the gutter stays clear to match it. Only with wrapping off
  // does the whole page scroll sideways under the sticky gutter; then it is opaque so that text does not show through.
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--color-text-tertiary)',
    border: '0',
  },
  '.cm-scroller:has(> .cm-content:not(.cm-lineWrapping)) > .cm-gutters': {
    backgroundColor: 'var(--color-surface-editor)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--color-editor-active-line)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--color-editor-active-line)',
    color: 'var(--color-text-primary)',
  },
  // The tint marks where the caret is, which only means something while the
  // editor has the keyboard: a note opens with its caret on line 1, and an
  // unfocused pane must not look as if the reader were typing there.
  '&:not(.cm-focused) .cm-activeLine, &:not(.cm-focused) .cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
  // The selection is drawn in a layer behind the lines, so the active line's tint lies over it.
  // A solid tint that stands 1.3:1 from both; lighter while the editor does not have focus.
  '.cm-selectionBackground': { backgroundColor: 'var(--color-accent-selection-inactive)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--color-accent-selection)',
  },
  // A full row is the column. A code or table line's own padding sits inside its
  // box (editor/selectionEdges.ts), so a side drawn at that padding grows back
  // out to the column, and the first and last rows the rest of the way from the
  // caret, so the tint wraps the box.
  '& > .cm-scroller > .cm-selectionLayer > .cm-selectionBackground:not(:first-child):not(:last-child)':
    {
      boxSizing: 'content-box',
      marginLeft: 'calc(-1 * var(--sel-box-left, 0px))',
      paddingLeft: 'var(--sel-box-left, 0px)',
      paddingRight: 'var(--sel-box-right, 0px)',
    },
  '& > .cm-scroller > .cm-selectionLayer > .cm-selectionBackground:first-child:not(:last-child)': {
    boxSizing: 'content-box',
    paddingRight: 'var(--sel-box-right, 0px)',
  },
  '& > .cm-scroller > .cm-selectionLayer > .cm-selectionBackground:last-child:not(:first-child)': {
    boxSizing: 'content-box',
    marginLeft: 'calc(-1 * var(--sel-box-left, 0px))',
    paddingLeft: 'var(--sel-box-left, 0px)',
  },
  '&.cm-sel-reach-start > .cm-scroller > .cm-selectionLayer > .cm-selectionBackground:first-child':
    {
      boxSizing: 'content-box',
      marginLeft: 'calc(-1 * var(--sel-reach-start, 0px))',
      paddingLeft: 'var(--sel-reach-start, 0px)',
    },
  '&.cm-sel-reach-end > .cm-scroller > .cm-selectionLayer > .cm-selectionBackground:last-child': {
    boxSizing: 'content-box',
    paddingRight: 'var(--sel-reach-end, 0px)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--color-fill-match)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--color-fill-track)',
    color: 'var(--color-text-secondary)',
    border: '0',
  },
  '.cm-tooltip': {
    border: '0',
    borderRadius: 'var(--radius-card)',
    backgroundColor: 'var(--color-surface-editor)',
    boxShadow: '0 0 0 0.5px var(--color-line-hairline)',
    color: 'var(--color-text-primary)',
  },
})

/**
 * Popups live in the frame around the scroll box so scrolling does not clip them: one over the first lines may reach up over the title and meta line, and a popup with no room above a line opens below it. A further box that clips (the split view's sideways scroll) holds them in too.
 */
export const popupSpace = (frame: HTMLElement) =>
  tooltips({
    parent: frame,
    tooltipSpace: (view) => {
      const root = view.dom.getRootNode()
      const host = root instanceof ShadowRoot ? (root.host as HTMLElement) : view.dom
      const box = host.getBoundingClientRect()
      const pane = host.closest('[data-devot-part="editor"]')
      const toolbar = pane?.querySelector('[data-devot-part="toolbar"]')
      if (!pane || !toolbar) return box
      let top = toolbar.getBoundingClientRect().bottom
      for (let el = host.parentElement; el && el !== pane; el = el.parentElement) {
        if (getComputedStyle(el).overflowY !== 'visible') {
          top = Math.max(top, el.getBoundingClientRect().top)
        }
      }
      return { left: box.left, right: box.right, top: Math.min(top, box.top), bottom: box.bottom }
    },
  })
