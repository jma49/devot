// Write mode's blocks: decorations that take whole lines (a folded front
// matter, rendered images, formulas, diagrams and embeds; tables next). CodeMirror takes
// those only from state, never from a view plugin, so they live in one state
// field fed by `writeBlockRule`: a step adds a rule, not another field.
import { syntaxTree } from '@codemirror/language'
import {
  Facet,
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

/** The block decorations of one kind for `state`, leaving out those on `revealed` lines. */
export type BlockRule = (state: EditorState, revealed: Revealed) => readonly Range<Decoration>[]

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

function build(state: EditorState): DecorationSet {
  const revealed = revealedIn(state)
  return Decoration.set(
    state.facet(writeBlockRule).flatMap((rule) => rule(state, revealed)),
    true,
  )
}

const changesBlocks = (tr: Transaction) =>
  tr.docChanged ||
  tr.selection !== undefined ||
  tr.reconfigured ||
  tr.effects.some((e) => e.is(setWriteFocus)) ||
  syntaxTree(tr.state) !== syntaxTree(tr.startState)

const userStep = (tr: Transaction) =>
  tr.annotation(Transaction.userEvent) !== undefined || tr.effects.some((e) => e.is(setWriteFocus))

interface Blocks {
  decorations: DecorationSet
  /** Mapped through a composition rather than built again; built on the first change after it. */
  stale: boolean
}

const blocks = StateField.define<Blocks>({
  create: (state) => ({ decorations: build(state), stale: false }),
  update(value, tr) {
    // Nothing is drawn again inside an input method's composition, nor for a
    // change from elsewhere (the parser, a sync) that may come during one: only
    // the user's next step after it builds the blocks again.
    if (tr.isUserEvent('input.type.compose') || (value.stale && !userStep(tr))) {
      return { decorations: value.decorations.map(tr.changes), stale: true }
    }
    if (!value.stale && !changesBlocks(tr)) return value
    return { decorations: build(tr.state), stale: false }
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
})

export const writeBlocks: Extension = [
  blocks,
  writeBlockRule.of(frontMatterRule),
  writeBlockRule.of(renderedBlockRule),
]
