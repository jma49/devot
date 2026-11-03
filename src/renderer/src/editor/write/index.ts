// Write mode: the editor hides the Markdown marks of every element the
// selection is not on and styles the text instead (rules.ts); the note stays
// Markdown, and the elements the selection meets show their source. Only the
// visible part of a note is decorated.
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, type EditorState, type Extension, type Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import type { LoadPreview } from '../../notePreview'
import { inlineImagesHidden } from '../images'
import { writeBlockKeys } from './blockKeys'
import { writeBlocks } from './blocks'
import { imageDoubleClick, writeRenderer, type WriteRenderer } from './rendered'
import { selectedIn } from './focus'
import { selectedKey, writeRanges, type Selected, type WriteRange } from './rules'
import { tableTheme, writeTables } from './tableGrid'
import { writeTheme } from './theme'
import { atomic, decorationOf, drawn, writeNoteLoader } from './widgets'

export { writeBlockRule, type BlockRule } from './blocks'
export type { WriteRenderer } from './rendered'
export { setWriteFocus, writeFocusTracking } from './focus'

function rangesIn(view: EditorView): { all: DecorationSet; atomic: DecorationSet } {
  const state = view.state
  const tree = syntaxTree(state)
  const selected = selectedIn(state)
  const seen = new Set<string>()
  const all: Range<Decoration>[] = []
  const units: Range<Decoration>[] = []
  const add = (range: WriteRange) => {
    const id = `${range.kind}:${range.from}:${range.to}`
    if (seen.has(id)) return
    seen.add(id)
    const decoration = decorationOf(range)
    if (range.kind === 'line') {
      all.push(decoration.range(state.doc.lineAt(range.from).from))
      return
    }
    const placed = decoration.range(range.from, range.to)
    if (drawn(range)) all.push(placed)
    if (atomic(range)) units.push(placed)
  }
  // Two visible ranges can share a node: `seen` keeps each piece once.
  for (const { from, to } of view.visibleRanges) {
    for (const range of writeRanges(state, tree, selected, from, to)) add(range)
  }
  return { all: Decoration.set(all, true), atomic: Decoration.set(units, true) }
}

const marks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    atomic: DecorationSet
    key: string
    /** Mapped through a composition rather than built again; built on the first update after it. */
    stale = false

    constructor(view: EditorView) {
      this.key = selectedKey(selectedIn(view.state))
      ;({ all: this.decorations, atomic: this.atomic } = rangesIn(view))
    }

    update(update: ViewUpdate) {
      // Decorations drawn again inside an input method's composition can drop or reorder what it typed.
      if (update.view.compositionStarted) {
        if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes)
          this.atomic = this.atomic.map(update.changes)
        }
        this.stale = true
        return
      }
      const key = selectedKey(selectedIn(update.state))
      if (
        !this.stale &&
        key === this.key &&
        !update.docChanged &&
        !update.viewportChanged &&
        syntaxTree(update.state) === syntaxTree(update.startState)
      )
        return
      this.stale = false
      this.key = key
      ;({ all: this.decorations, atomic: this.atomic } = rangesIn(update.view))
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
  },
)

/** How far the pointer may move between the clicks of a double click, in pixels. */
const CLICK_SLOP = 4

/** Whether a caret at `pos` would show marks on its line that `selected` leaves hidden. */
function opensAt(state: EditorState, selected: Selected, pos: number): boolean {
  const line = state.doc.lineAt(pos)
  const tree = syntaxTree(state)
  const key = (ranges: WriteRange[]) =>
    ranges
      .filter(drawn)
      .map((r) => `${r.kind}:${r.from}:${r.to}`)
      .sort()
      .join(',')
  return (
    key(writeRanges(state, tree, selected, line.from, line.to)) !==
    key(writeRanges(state, tree, [{ from: pos, to: pos }], line.from, line.to))
  )
}

/**
 * The first click on an element shows its marks, which moves the text after
 * them under the pointer: a double click there takes the word the first click
 * was on, not the one that came under the pointer.
 */
function clickedWords(): Extension {
  let first: { pos: number; x: number; y: number; opened: boolean } | null = null
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0) return false
      if (event.detail <= 1) {
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        first =
          pos === null
            ? null
            : {
                pos,
                x: event.clientX,
                y: event.clientY,
                opened: opensAt(view.state, selectedIn(view.state), pos),
              }
        return false
      }
      const at = first
      if (
        event.detail !== 2 ||
        !at?.opened ||
        event.shiftKey ||
        event.metaKey ||
        event.altKey ||
        event.ctrlKey ||
        Math.abs(event.clientX - at.x) > CLICK_SLOP ||
        Math.abs(event.clientY - at.y) > CLICK_SLOP ||
        at.pos > view.state.doc.length
      )
        return false
      const word = view.state.wordAt(at.pos)
      if (!word) return false
      event.preventDefault()
      view.dispatch({
        selection: EditorSelection.range(word.from, word.to),
        userEvent: 'select.pointer',
      })
      return true
    },
  })
}

export interface WriteModeOptions {
  /** Titles for note links with no text of their own. */
  loadNote?: LoadPreview
  /** Renders images, formulas, diagrams and embeds as the preview does. */
  render?: WriteRenderer
}

export function writeMode(options: WriteModeOptions = {}): Extension {
  return [
    marks,
    imageDoubleClick,
    clickedWords(),
    writeBlocks,
    writeTables,
    writeBlockKeys,
    writeTheme,
    tableTheme,
    inlineImagesHidden.of(true),
    options.loadNote ? writeNoteLoader.of(options.loadNote) : [],
    options.render ? writeRenderer.of(options.render) : [],
    EditorView.editorAttributes.of({ 'data-write': '' }),
  ]
}
