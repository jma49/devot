// Write mode: the editor hides the Markdown marks of every line the
// selection is not on and styles the text instead (rules.ts); the note stays
// Markdown, and the lines with the selection show their source. Only the
// visible part of a note is decorated.
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, type Extension, type Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import type { LoadPreview } from '../../notePreview'
import { writeBlocks } from './blocks'
import { revealedIn } from './focus'
import { isRevealed, revealedKey, writeRanges, type WriteRange } from './rules'
import { writeTheme } from './theme'
import { decorationOf, replaces, writeNoteLoader } from './widgets'

export { writeBlockRule, type BlockRule } from './blocks'
export { setWriteFocus, writeFocusTracking } from './focus'

function rangesIn(view: EditorView): { all: DecorationSet; atomic: DecorationSet } {
  const state = view.state
  const tree = syntaxTree(state)
  const revealed = revealedIn(state)
  const seen = new Set<string>()
  const all: Range<Decoration>[] = []
  const atomic: Range<Decoration>[] = []
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
    all.push(placed)
    if (replaces(range)) atomic.push(placed)
  }
  // Two visible ranges can share a node: `seen` keeps each piece once.
  for (const { from, to } of view.visibleRanges) {
    for (const range of writeRanges(state, tree, revealed, from, to)) add(range)
  }
  return { all: Decoration.set(all, true), atomic: Decoration.set(atomic, true) }
}

const marks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    atomic: DecorationSet
    key: string
    /** Mapped through a composition rather than built again; built on the first update after it. */
    stale = false

    constructor(view: EditorView) {
      this.key = revealedKey(revealedIn(view.state))
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
      const key = revealedKey(revealedIn(update.state))
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

/**
 * The first click on a line shows its marks, which moves its text under the
 * pointer: a double click there takes the word the first click was on, not
 * the one that came under the pointer.
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
                opened: !isRevealed(revealedIn(view.state), view.state.doc.lineAt(pos).number),
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
}

export function writeMode(options: WriteModeOptions = {}): Extension {
  return [
    marks,
    clickedWords(),
    writeBlocks,
    writeTheme,
    options.loadNote ? writeNoteLoader.of(options.loadNote) : [],
    EditorView.editorAttributes.of({ 'data-write': '' }),
  ]
}
