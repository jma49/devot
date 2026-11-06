// Write mode's blocks: decorations that take whole lines (a folded front
// matter, rendered images, formulas, diagrams and embeds, tables). CodeMirror takes
// those only from state, never from a view plugin, so they live in one state
// field fed by `writeBlockRule`: a step adds a rule, not another field. An edit
// or a caret move draws again only the blocks it touches (changes.ts).
import { syntaxTree } from '@codemirror/language'
import {
  Facet,
  MapMode,
  RangeSet,
  RangeValue,
  StateField,
  type EditorState,
  type Extension,
  Transaction,
  type Range,
} from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { t } from '../../i18n'
import { FRONT_MATTER } from '../markdown'
import { revealedIn, setWriteFocus } from './focus'
import { blockLook, carryWriteBlocks, writeBlocksOf } from './blockRanges'
import { changedSpans, firstReaching, lineSpans, type Span } from './changes'
import { RenderedBlockWidget } from './rendered'
import { isRevealed, type Revealed } from './selection'

/**
 * A rule's decorations in layers: `outer` marks wrap all others and stay in
 * one piece; `atomic` is what the caret steps over.
 */
export interface BlockLayers {
  decorations: readonly Range<Decoration>[]
  outer: readonly Range<Decoration>[]
  atomic: readonly Range<Decoration>[]
}

/** One block's decorations, all of them inside `from`..`to` (both included). */
export interface BlockPiece {
  from: number
  to: number
  layers: BlockLayers
}

export interface BlockRule {
  /** The pieces of the blocks of one kind that meet `from`..`to`, leaving out those on `revealed` lines. */
  pieces(state: EditorState, revealed: Revealed, from: number, to: number): readonly BlockPiece[]
  /**
   * Brings what the rule reads from the note up to date after a step, reading
   * again only `changed` and as far as that reaches. Returns the spans read
   * again; null when it could not keep what it read, and reads the note again.
   */
  carry?(tr: Transaction, changed: readonly Span[]): readonly Span[] | null
}

export const writeBlockRule = Facet.define<BlockRule>()

const KEY = /^([^\s:#][^:]*):/

class FrontMatterWidget extends WidgetType {
  constructor(readonly keys: string) {
    super()
  }

  override eq(other: FrontMatterWidget): boolean {
    return other.keys === this.keys
  }

  override toDOM(view: EditorView): HTMLElement {
    const row = document.createElement('div')
    row.className = 'cm-wm-front-matter'
    const label = document.createElement('span')
    label.className = 'cm-wm-front-matter-label'
    label.textContent = t('write.frontMatter')
    row.append(label)
    if (this.keys) {
      const keys = document.createElement('span')
      keys.className = 'cm-wm-front-matter-keys'
      keys.textContent = this.keys
      row.append(keys)
    }
    row.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const doc = view.state.doc
      const inside = doc.lines > 1 ? doc.line(2).from : 0
      view.dispatch({ selection: { anchor: inside }, scrollIntoView: true })
      view.focus()
    })
    return row
  }

  override ignoreEvent(): boolean {
    return true
  }
}

const alone = (range: Range<Decoration>): BlockLayers => ({
  decorations: [range],
  outer: [],
  atomic: [range],
})

/** Front matter folds to one row naming its keys; the caret inside opens it. */
export const frontMatterRule: BlockRule = {
  pieces(state, revealed, from) {
    const node = syntaxTree(state).topNode.firstChild
    if (node?.name !== FRONT_MATTER || node.from !== 0 || from > node.to) return []
    const last = state.doc.lineAt(node.to).number
    for (let n = 1; n <= last; n++) if (isRevealed(revealed, n)) return []
    const keys: string[] = []
    for (let n = 2; n < last; n++) {
      const key = KEY.exec(state.doc.line(n).text)?.[1]?.trim()
      if (key) keys.push(key)
    }
    const widget = new FrontMatterWidget(keys.join(', '))
    const range = Decoration.replace({ widget, block: true }).range(0, node.to)
    return [{ from: 0, to: node.to, layers: alone(range) }]
  },
}

/**
 * Images, formulas, diagrams and embeds as the preview shows them. A closed
 * block takes its lines; an open one shows its source with the rendering under it.
 */
export const renderedBlockRule: BlockRule = {
  pieces(state, _revealed, from, to) {
    const blocks = writeBlocksOf(state)
    const out: BlockPiece[] = []
    for (let i = firstReaching(blocks, from); i < blocks.length; i++) {
      const block = blocks[i]!
      if (block.from > to) break
      const look = blockLook(state, block)
      const widget = new RenderedBlockWidget(block, look)
      const range =
        look === 'open'
          ? Decoration.widget({ widget, block: true, side: 1 }).range(block.to)
          : Decoration.replace({ widget, block: true }).range(block.from, block.to)
      out.push({ from: block.from, to: block.to, layers: alone(range) })
    }
    return out
  },
  carry: carryWriteBlocks,
}

type Layers = Record<keyof BlockLayers, DecorationSet>
const LAYERS = ['decorations', 'outer', 'atomic'] as const

/** Where a piece's decorations lie: it moves with the text as they do, edges outward, and is never dropped. */
class Extent extends RangeValue {
  override startSide = -1
  override endSide = 1
  override mapMode = MapMode.Simple
}
const extent = new Extent()

interface Blocks {
  layers: Layers
  pieces: RangeSet<Extent>
  /** Mapped through a composition rather than built again; built on the first change after it. */
  stale: boolean
}

function piecesIn(state: EditorState, revealed: Revealed, from: number, to: number): BlockPiece[] {
  const out: BlockPiece[] = []
  for (const rule of state.facet(writeBlockRule))
    for (const piece of rule.pieces(state, revealed, from, to)) out.push(piece)
  return out
}

function rangesOf(pieces: readonly BlockPiece[]): Record<keyof BlockLayers, Range<Decoration>[]> {
  const out: Record<keyof BlockLayers, Range<Decoration>[]> = {
    decorations: [],
    outer: [],
    atomic: [],
  }
  for (const { layers } of pieces)
    for (const layer of LAYERS) for (const range of layers[layer]) out[layer].push(range)
  return out
}

const extentsOf = (pieces: readonly BlockPiece[]) =>
  pieces.map((piece) => extent.range(piece.from, piece.to))

function build(state: EditorState): Blocks {
  const pieces = piecesIn(state, revealedIn(state), 0, state.doc.length)
  const ranges = rangesOf(pieces)
  return {
    layers: {
      decorations: Decoration.set(ranges.decorations, true),
      outer: Decoration.set(ranges.outer, true),
      atomic: RangeSet.of(ranges.atomic, true),
    },
    pieces: RangeSet.of(extentsOf(pieces), true),
    stale: false,
  }
}

const mapped = (value: Blocks, tr: Transaction, stale: boolean): Blocks => ({
  layers: {
    decorations: value.layers.decorations.map(tr.changes),
    outer: value.layers.outer.map(tr.changes),
    atomic: value.layers.atomic.map(tr.changes),
  },
  pieces: value.pieces.map(tr.changes),
  stale,
})

/**
 * Draws again the pieces that meet `spans` (sorted spans of the new note),
 * and those that meet the pieces drawn, until none is left half drawn; every
 * other piece keeps its decorations, moved with the text.
 */
function redraw(value: Blocks, tr: Transaction, spans: readonly Span[]): Blocks {
  const { state } = tr
  const revealed = revealedIn(state)
  let { layers, pieces } = mapped(value, tr, false)
  for (let r = 0; r < spans.length;) {
    let [from, to] = spans[r++]!
    let found: BlockPiece[] = []
    for (let grew = true; grew;) {
      grew = false
      pieces.between(from, to, (a, b) => {
        if (a >= from && b <= to) return
        from = Math.min(from, a)
        to = Math.max(to, b)
        grew = true
      })
      while (r < spans.length && spans[r]![0] <= to) to = Math.max(to, spans[r++]![1])
      found = piecesIn(state, revealed, from, to)
      for (const piece of found) {
        if (piece.from >= from && piece.to <= to) continue
        from = Math.min(from, piece.from)
        to = Math.max(to, piece.to)
        grew = true
      }
    }
    // Every decoration lies inside its piece, and every piece that meets the span is inside it now.
    const outside = (a: number, b: number) => a < from || b > to
    const replace = <T extends RangeValue>(set: RangeSet<T>, add: readonly Range<T>[]) =>
      set.update({
        add,
        sort: true,
        filter: outside,
        filterFrom: from,
        filterTo: to,
      })
    const ranges = rangesOf(found)
    layers = {
      decorations: replace(layers.decorations, ranges.decorations),
      outer: replace(layers.outer, ranges.outer),
      atomic: replace(layers.atomic, ranges.atomic),
    }
    pieces = replace(pieces, extentsOf(found))
  }
  return { layers, pieces, stale: false }
}

const focusChanged = (tr: Transaction) => tr.effects.some((e) => e.is(setWriteFocus))

const changesBlocks = (tr: Transaction) =>
  tr.docChanged ||
  tr.selection !== undefined ||
  tr.reconfigured ||
  focusChanged(tr) ||
  syntaxTree(tr.state) !== syntaxTree(tr.startState)

const userStep = (tr: Transaction) =>
  tr.annotation(Transaction.userEvent) !== undefined || focusChanged(tr)

/** What to draw again after `tr`: what it changed, and the lines its selection left and came to. */
function spansOf(tr: Transaction, changed: readonly Span[]): readonly Span[] {
  if (tr.selection === undefined && !focusChanged(tr)) return lineSpans(tr.state.doc, changed)
  const before = tr.startState.selection.map(tr.changes).ranges
  const lines = [...before, ...tr.state.selection.ranges].map((r): Span => [r.from, r.to])
  return lineSpans(tr.state.doc, [...changed, ...lines])
}

const blocks = StateField.define<Blocks>({
  create: build,
  update(value, tr) {
    // Nothing is drawn again inside an input method's composition, nor for a
    // change from elsewhere (the parser, a sync) that may come during one: only
    // the user's next step after it builds the blocks again.
    if (tr.isUserEvent('input.type.compose') || (value.stale && !userStep(tr))) {
      return mapped(value, tr, true)
    }
    if (!value.stale && !changesBlocks(tr)) return value
    const changed = value.stale ? null : changedSpans(tr)
    if (!changed) return build(tr.state)
    const read: Span[] = [...changed]
    for (const rule of tr.state.facet(writeBlockRule)) {
      const spans = rule.carry ? rule.carry(tr, changed) : []
      if (spans === null) return build(tr.state)
      read.push(...spans)
    }
    return redraw(value, tr, spansOf(tr, read))
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.layers.decorations),
    EditorView.outerDecorations.from(field, (value) => value.layers.outer),
    EditorView.atomicRanges.of((view) => view.state.field(field).layers.atomic),
  ],
})

export const writeBlocks: Extension = [
  blocks,
  writeBlockRule.of(frontMatterRule),
  writeBlockRule.of(renderedBlockRule),
]
