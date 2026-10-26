// Ghost text in the note editor. The empty line holding the cursor says that
// `/` lists commands; an empty note says to start typing, or offers a chip
// that runs New Note from Template. Neither is part of the text: the line's
// hint is drawn by CSS from an attribute, and the empty note's sits over the
// editor, outside its content.
import { RangeSetBuilder, type EditorState, type Extension, Facet } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { shortcutLabel } from '../commands/keys'
import { commandKeys } from '../commands/registry'
import { t } from '../i18n'
import {
  blockAround,
  context,
  inFrontMatter,
  LITERAL_TEXT,
  TOOLBAR_PARSE_MS,
} from './formatContext'

export const chooseTemplate = Facet.define<() => void, (() => void) | null>({
  combine: (values) => values[0] ?? null,
})

/**
 * The line that shows the slash hint, by its start, or null: one empty
 * cursor on an empty line of a note that is not empty, where `/` opens the
 * menu (not in code, HTML or front matter).
 */
export function slashHintLine(state: EditorState): number | null {
  const { ranges, main } = state.selection
  if (state.doc.length === 0 || ranges.length > 1 || !main.empty) return null
  const line = state.doc.lineAt(main.head)
  if (line.length > 0) return null
  const cx = context(state, TOOLBAR_PARSE_MS)
  if (!cx || inFrontMatter(cx, line.from) || blockAround(cx, line.from, LITERAL_TEXT)) return null
  return line.from
}

function lineHint(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const at = view.hasFocus ? slashHintLine(view.state) : null
  if (at !== null) {
    builder.add(
      at,
      at,
      Decoration.line({
        class: 'cm-slash-hint',
        attributes: { 'data-hint': t('editor.slashHint') },
      }),
    )
  }
  return builder.finish()
}

const slashHint = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = lineHint(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.focusChanged)
        this.decorations = lineHint(update.view)
    }
  },
  { decorations: (v) => v.decorations },
)

const emptyNote = ViewPlugin.fromClass(
  class {
    dom: HTMLElement
    constructor(readonly view: EditorView) {
      this.dom = document.createElement('div')
      this.dom.className = 'cm-empty-hint'
      const text = document.createElement('span')
      text.textContent = t('editor.emptyNoteHint')
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'cm-template-chip'
      chip.append(t('editor.chooseTemplate'))
      const key = commandKeys('note.newFromTemplate')[0]
      if (key) {
        const cap = document.createElement('kbd')
        cap.className = 'cm-template-key'
        cap.textContent = shortcutLabel(key)
        chip.append(cap)
      }
      chip.addEventListener('mousedown', (event) => event.preventDefault())
      chip.addEventListener('click', (event) => {
        event.preventDefault()
        view.state.facet(chooseTemplate)?.()
      })
      this.dom.append(text, chip)
      view.dom.appendChild(this.dom)
      this.place()
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.geometryChanged ||
        update.startState.facet(chooseTemplate) !== update.state.facet(chooseTemplate)
      )
        this.place()
    }
    place() {
      const { view, dom } = this
      const empty = view.state.doc.length === 0
      dom.hidden = !empty
      chipShown(dom, view.state.facet(chooseTemplate) !== null)
      if (!empty) return
      view.requestMeasure({
        read: () => {
          const line = view.lineBlockAt(0)
          const at = view.coordsAtPos(0)
          const box = view.dom.getBoundingClientRect()
          if (!at) return null
          const top = view.documentTop + line.top - box.top
          return { top, left: at.left - box.left, height: line.height }
        },
        write: (pos) => {
          if (!pos) return
          dom.style.top = `${pos.top}px`
          dom.style.left = `${pos.left}px`
          dom.style.height = `${pos.height}px`
        },
      })
    }
    destroy() {
      this.dom.remove()
    }
  },
)

function chipShown(dom: HTMLElement, shown: boolean) {
  const chip = dom.querySelector('button')
  if (chip) chip.hidden = !shown
}

const theme = EditorView.theme({
  '.cm-line.cm-slash-hint': { position: 'relative' },
  // Out of the flow, so the cursor stays at the start of the line.
  '.cm-line.cm-slash-hint::before': {
    content: 'attr(data-hint)',
    position: 'absolute',
    pointerEvents: 'none',
    color: 'var(--color-text-placeholder)',
    whiteSpace: 'nowrap',
  },
  // Sits outside the scroller, so it takes the editor's font itself, centred on the first line.
  '.cm-empty-hint': {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
    color: 'var(--color-text-placeholder)',
    fontSize: 'var(--editor-font-size, var(--font-size-body))',
    fontFamily: 'var(--editor-font-family, var(--font-family-mono))',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
  },
  '.cm-empty-hint[hidden], .cm-template-chip[hidden]': { display: 'none' },
  '.cm-template-chip': {
    pointerEvents: 'auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
    height: 'var(--size-segment-height)',
    margin: '0',
    padding: '0 var(--space-2) 0 var(--space-3)',
    border: '1px solid var(--color-line-control)',
    borderRadius: 'var(--radius-button)',
    background: 'var(--color-fill-button)',
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-family-ui)',
    fontSize: 'var(--font-size-footnote)',
    lineHeight: '1',
    cursor: 'default',
  },
  '.cm-template-key': {
    padding: '0 var(--space-2)',
    border: '1px solid var(--color-line-control)',
    borderRadius: 'var(--radius-control)',
    color: 'var(--color-text-secondary)',
    font: 'inherit',
    fontSize: 'var(--font-size-caption)',
    lineHeight: '1.4',
  },
})

export function editorHints(): Extension {
  return [slashHint, emptyNote, theme]
}
