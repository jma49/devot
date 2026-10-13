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

/** Runs New Note from Template (the editor's host provides it). */
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

/** The empty note's hint: over the first line, gone once the note has text. */
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
      const key = commandKeys('note.newFromTemplate')[0]
      chip.textContent = key
        ? `${t('editor.chooseTemplate')} ${shortcutLabel(key)}`
        : t('editor.chooseTemplate')
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
      if (update.docChanged || update.geometryChanged) this.place()
    }
    place() {
      const { view, dom } = this
      const empty = view.state.doc.length === 0
      dom.hidden = !empty
      chipShown(dom, view.state.facet(chooseTemplate) !== null)
      if (!empty) return
      view.requestMeasure({
        read: () => {
          const at = view.coordsAtPos(0)
          const box = view.dom.getBoundingClientRect()
          return at ? { top: at.top - box.top, left: at.left - box.left } : null
        },
        write: (pos) => {
          if (!pos) return
          dom.style.top = `${pos.top}px`
          dom.style.left = `${pos.left}px`
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
  '.cm-empty-hint': {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
    color: 'var(--color-text-placeholder)',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
  },
  '.cm-empty-hint[hidden], .cm-template-chip[hidden]': { display: 'none' },
  '.cm-template-chip': {
    pointerEvents: 'auto',
    padding: '0 var(--space-3)',
    border: '1px solid var(--color-line-control)',
    borderRadius: 'var(--radius-button)',
    background: 'var(--color-fill-button)',
    color: 'var(--color-text-secondary)',
    fontFamily: 'var(--font-family-ui)',
    fontSize: 'var(--font-size-footnote)',
    lineHeight: '1.5',
    cursor: 'default',
  },
  '.cm-template-chip:hover': { color: 'var(--color-text-primary)' },
})

/** The slash hint on an empty line and the empty note's hint, for the note editor. */
export function editorHints(): Extension {
  return [slashHint, emptyNote, theme]
}
