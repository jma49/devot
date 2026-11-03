// Write mode's blocks: decorations that take whole lines (a folded front
// matter, rendered images, formulas, diagrams and embeds, tables). CodeMirror takes
// those only from state, never from a view plugin, so they live in one state
// field fed by `writeBlockRule`: a step adds a rule, not another field.
import { syntaxTree } from '@codemirror/language'
import {
  Facet,
  RangeSet,
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
import { blockLook, writeBlocksOf } from './blockRanges'
import { RenderedBlockWidget } from './rendered'
import type { Revealed } from './rules'
import { isRevealed } from './rules'

/**
 * A rule's decorations in layers: `outer` marks wrap all others and stay in
 * one piece; `atomic` is what the caret steps over (by default, every
 * decoration of a rule that returns a plain list).
 */
export interface BlockLayers {
  decorations: readonly Range<Decoration>[]
  outer: readonly Range<Decoration>[]
  atomic: readonly Range<Decoration>[]
}

/** The block decorations of one kind for `state`, leaving out those on `revealed` lines. */
export type BlockRule = (
  state: EditorState,
  revealed: Revealed,
) => readonly Range<Decoration>[] | BlockLayers

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

/** Front matter folds to one row naming its keys; the caret inside opens it. */
export const frontMatterRule: BlockRule = (state, revealed) => {
  const node = syntaxTree(state).topNode.firstChild
  if (node?.name !== FRONT_MATTER || node.from !== 0) return []
  const last = state.doc.lineAt(node.to).number
  for (let n = 1; n <= last; n++) if (isRevealed(revealed, n)) return []
  const keys: string[] = []
  for (let n = 2; n < last; n++) {
    const key = KEY.exec(state.doc.line(n).text)?.[1]?.trim()
    if (key) keys.push(key)
  }
  const widget = new FrontMatterWidget(keys.join(', '))
  return [Decoration.replace({ widget, block: true }).range(0, node.to)]
}

/**
 * Images, formulas, diagrams and embeds as the preview shows them. A closed
 * block takes its lines; an open one shows its source with the rendering under it.
 */
export const renderedBlockRule: BlockRule = (state) =>
  writeBlocksOf(state).map((block) => {
    const look = blockLook(state, block)
    const widget = new RenderedBlockWidget(block, look)
    return look === 'open'
      ? Decoration.widget({ widget, block: true, side: 1 }).range(block.to)
      : Decoration.replace({ widget, block: true }).range(block.from, block.to)
  })

type Layers = Record<keyof BlockLayers, DecorationSet>

function build(state: EditorState): Layers {
  const revealed = revealedIn(state)
  const all: Range<Decoration>[] = []
  const outer: Range<Decoration>[] = []
  const atomic: Range<Decoration>[] = []
  for (const rule of state.facet(writeBlockRule)) {
    const out = rule(state, revealed)
    if (Array.isArray(out)) {
      all.push(...(out as readonly Range<Decoration>[]))
      atomic.push(...(out as readonly Range<Decoration>[]))
    } else {
      const layers = out as BlockLayers
      all.push(...layers.decorations)
      outer.push(...layers.outer)
      atomic.push(...layers.atomic)
    }
  }
  return {
    decorations: Decoration.set(all, true),
    outer: Decoration.set(outer, true),
    atomic: RangeSet.of(atomic, true),
  }
}

const mapLayers = (layers: Layers, tr: Transaction): Layers => ({
  decorations: layers.decorations.map(tr.changes),
  outer: layers.outer.map(tr.changes),
  atomic: layers.atomic.map(tr.changes),
})

const changesBlocks = (tr: Transaction) =>
  tr.docChanged ||
  tr.selection !== undefined ||
  tr.reconfigured ||
  tr.effects.some((e) => e.is(setWriteFocus)) ||
  syntaxTree(tr.state) !== syntaxTree(tr.startState)

const userStep = (tr: Transaction) =>
  tr.annotation(Transaction.userEvent) !== undefined || tr.effects.some((e) => e.is(setWriteFocus))

interface Blocks {
  layers: Layers
  /** Mapped through a composition rather than built again; built on the first change after it. */
  stale: boolean
}

const blocks = StateField.define<Blocks>({
  create: (state) => ({ layers: build(state), stale: false }),
  update(value, tr) {
    // Nothing is drawn again inside an input method's composition, nor for a
    // change from elsewhere (the parser, a sync) that may come during one: only
    // the user's next step after it builds the blocks again.
    if (tr.isUserEvent('input.type.compose') || (value.stale && !userStep(tr))) {
      return { layers: mapLayers(value.layers, tr), stale: true }
    }
    if (!value.stale && !changesBlocks(tr)) return value
    return { layers: build(tr.state), stale: false }
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
