// Blocks that keep their lines whole while the rest of the note wraps: in
// the Prose line wrapping mode every code block and table, in Unwrap at
// Cursor only the one that holds the caret. Code inside a quote or an alert
// wraps with it. An unwrapped line scrolls sideways (with the editor's
// sideways scroll) instead of wrapping; every line of a block is as wide as
// its widest one, so the block's box keeps straight sides.
//
// When a block wraps or unwraps under the caret (or the mode changes), the
// caret's line keeps its place on screen: the scroll box is put back a few
// times while the heights settle, until the user scrolls, clicks or types.
import { syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  type EditorState,
  Facet,
  Prec,
  type Range,
  StateEffect,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type KeyBinding,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

/** Which blocks keep their lines whole: all of them, the one under the caret, or none. */
export const unwrapMode = Facet.define<'all' | 'active' | null, 'all' | 'active' | null>({
  combine: (values) => values[0] ?? null,
})

/** A block that does not wrap: where it starts and the start of each of its lines. */
export interface UnwrapBlock {
  from: number
  lines: number[]
}

const BLOCKS = new Set(['FencedCode', 'CodeBlock', 'Table'])

/** Whether `node` is a code block or a table outside any quote (an alert is a quote). */
function unwrappable(node: SyntaxNode): boolean {
  if (!BLOCKS.has(node.name)) return false
  for (let up = node.parent; up; up = up.parent) if (up.name === 'Blockquote') return false
  return true
}

function linesOf(state: EditorState, node: SyntaxNode): UnwrapBlock {
  const { doc } = state
  const first = doc.lineAt(node.from).number
  // A node can end at the start of the next line: that line is not in it.
  const end = doc.lineAt(node.to)
  const last = end.from === node.to && end.number > first ? end.number - 1 : end.number
  const lines: number[] = []
  for (let n = first; n <= last; n++) lines.push(doc.line(n).from)
  return { from: node.from, lines }
}

/** The code block or table that holds the main caret, if any. */
export function activeBlock(state: EditorState): SyntaxNode | null {
  const head = state.selection.main.head
  const tree = syntaxTree(state)
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(head, side); node; node = node.parent)
      if (BLOCKS.has(node.name)) return unwrappable(node) ? node : null
  }
  return null
}

/** The blocks that do not wrap in `ranges` (the visible ones), as `unwrapMode` says. */
export function unwrapLines(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): UnwrapBlock[] {
  const mode = state.facet(unwrapMode)
  if (mode === 'active') {
    const block = activeBlock(state)
    return block ? [linesOf(state, block)] : []
  }
  if (mode !== 'all') return []
  const out: UnwrapBlock[] = []
  const seen = new Set<number>()
  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name === 'Paragraph') return false
        if (!BLOCKS.has(node.name)) return undefined
        if (unwrappable(node.node) && !seen.has(node.from)) {
          seen.add(node.from)
          out.push(linesOf(state, node.node))
        }
        return false
      },
    })
  }
  return out.sort((a, b) => a.from - b.from)
}

/** Asks the editor to keep the caret's line where it is on screen while lines rewrap. */
export const keepCaretLine = StateEffect.define<null>()

/** How many times, and for how long, the caret's line is put back while heights settle. */
const KEEP_ROUNDS = 5
const KEEP_MS = 500
const RELEASE_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

/** The element that scrolls the editor up and down: the nearest scrolling box around it. */
function verticalScroller(view: EditorView): HTMLElement {
  for (let el = view.dom.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el)
    if (overflowY === 'auto' || overflowY === 'scroll') return el
  }
  return view.scrollDOM
}

/** The caret line's top, from the scroll box's top edge, in pixels. */
const caretOffset = (view: EditorView, scroller: HTMLElement, head: number) =>
  view.documentTop + view.lineBlockAt(head).top - scroller.getBoundingClientRect().top

/**
 * Keeps the caret's line at its screen position across a rewrap: `hold`
 * reads where it is (before the editor draws the change), then each round
 * scrolls it back. Scrolling, a click, a key or any later edit or caret
 * move lets go.
 */
class CaretKeeper {
  private held: { head: number; offset: number; scroller: HTMLElement } | null = null
  private rounds = 0
  private started = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly release = () => this.letGo()

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate) {
    const asked = update.transactions.some((tr) => tr.effects.some((e) => e.is(keepCaretLine)))
    if (asked) this.hold()
    else if (this.held && (update.docChanged || update.selectionSet)) this.letGo()
  }

  /** Notes where the caret's line is; call before the change is drawn. */
  hold() {
    const { view } = this
    const head = view.state.selection.main.head
    const scroller = verticalScroller(view)
    const offset = caretOffset(view, scroller, head)
    // A caret off screen has no place to keep.
    if (offset < 0 || offset > scroller.clientHeight) return this.letGo()
    if (!this.held)
      for (const name of RELEASE_EVENTS) view.dom.addEventListener(name, this.release, true)
    this.held = { head, offset, scroller }
    this.rounds = 0
    this.started = Date.now()
    this.round(true)
  }

  private round(first: boolean) {
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        const held = this.held
        if (!held) return null
        const caret = view.coordsAtPos(held.head)
        const box = view.scrollDOM.getBoundingClientRect()
        return {
          held,
          drift: caretOffset(view, held.scroller, held.head) - held.offset,
          caret,
          box,
        }
      },
      write: (measured, view) => {
        if (!measured) return
        const { held, drift, caret, box } = measured
        if (Math.abs(drift) >= 0.5) held.scroller.scrollTop += drift
        // Once, sideways too, so a caret that ends up past an edge shows.
        if (first && caret) {
          if (caret.left < box.left) view.scrollDOM.scrollLeft -= box.left - caret.left
          else if (caret.right > box.right) view.scrollDOM.scrollLeft += caret.right - box.right
        }
        this.rounds++
        clearTimeout(this.timer)
        if (this.rounds >= KEEP_ROUNDS || Date.now() - this.started >= KEEP_MS) return this.letGo()
        this.timer = setTimeout(() => this.round(false), KEEP_MS / KEEP_ROUNDS)
      },
    })
  }

  private letGo() {
    clearTimeout(this.timer)
    if (this.held)
      for (const name of RELEASE_EVENTS) this.view.dom.removeEventListener(name, this.release, true)
    this.held = null
  }

  destroy() {
    this.letGo()
  }
}

const caretKeeper = ViewPlugin.fromClass(CaretKeeper)

/** New line widths were measured: the decorations carry them. */
const widthsMeasured = StateEffect.define<null>()

/** The CSS variable each unwrapped line takes its block's width from. */
const WIDTH_VAR = '--editor-unwrap-width'

const lineDeco = (width: number | undefined) =>
  Decoration.line({
    class: 'cm-unwrap',
    ...(width === undefined ? {} : { attributes: { style: `${WIDTH_VAR}: ${width}px` } }),
  })

/**
 * Draws the unwrapped lines and measures them: each line's text width
 * (its natural one, as `white-space: pre` lays it out) plus its padding,
 * the block's width being its widest line's. Widths are kept per line start
 * and moved through edits, so lines scrolled out of view keep theirs.
 */
class Unwrapper {
  decorations: DecorationSet = Decoration.none
  private blocks: UnwrapBlock[] = []
  private widths = new Map<number, number>()
  private active: number | null = null

  constructor(private readonly view: EditorView) {
    this.recompute(false)
  }

  update(update: ViewUpdate) {
    if (update.docChanged) {
      const moved = new Map<number, number>()
      for (const [from, width] of this.widths) {
        const line = update.state.doc.lineAt(update.changes.mapPos(from))
        if (!update.changes.touchesRange(from, from)) moved.set(line.from, width)
      }
      this.widths = moved
    }
    if (
      update.docChanged ||
      update.viewportChanged ||
      update.selectionSet ||
      update.geometryChanged ||
      syntaxTree(update.state) !== syntaxTree(update.startState) ||
      update.state.facet(unwrapMode) !== update.startState.facet(unwrapMode)
    )
      this.recompute(update.selectionSet && !update.docChanged)
    else if (update.transactions.some((tr) => tr.effects.some((e) => e.is(widthsMeasured))))
      this.draw()
  }

  /** Finds the blocks again; `caretMoved` keeps the caret's line in place when the active block changes. */
  private recompute(caretMoved: boolean) {
    const { view } = this
    this.blocks = unwrapLines(view.state, view.visibleRanges)
    if (view.state.facet(unwrapMode) === 'active') {
      const active = this.blocks[0]?.from ?? null
      if (active !== this.active && caretMoved) view.plugin(caretKeeper)?.hold()
      this.active = active
    }
    this.draw()
    if (this.blocks.length > 0)
      view.requestMeasure({
        key: this,
        read: () => this.measure(),
        write: (changed) => changed && this.redraw(),
      })
  }

  private draw() {
    const decos: Range<Decoration>[] = []
    for (const block of this.blocks) {
      let width: number | undefined
      for (const from of block.lines) {
        const w = this.widths.get(from)
        if (w !== undefined) width = Math.max(width ?? 0, w)
      }
      const deco = lineDeco(width)
      for (const from of block.lines) decos.push(deco.range(from))
    }
    this.decorations = Decoration.set(decos)
  }

  /** Reads the width of each unwrapped line on screen; true when any changed. */
  private measure(): boolean {
    const { view } = this
    let changed = false
    const range = document.createRange()
    for (const block of this.blocks) {
      for (const from of block.lines) {
        const { node } = view.domAtPos(from)
        const line = (node instanceof Element ? node : node.parentElement)?.closest('.cm-line')
        if (!(line instanceof HTMLElement) || !line.classList.contains('cm-unwrap')) continue
        const box = line.getBoundingClientRect()
        // The text's right edge; widgets (a copy button in the corner) do not count.
        let right = box.left + parseFloat(getComputedStyle(line).paddingLeft)
        for (const child of line.childNodes) {
          if (child instanceof HTMLElement && child.contentEditable === 'false') continue
          if (child instanceof HTMLImageElement) continue
          range.selectNodeContents(child)
          const rect = range.getBoundingClientRect()
          if (rect.width > 0) right = Math.max(right, rect.right)
        }
        const pad = parseFloat(getComputedStyle(line).paddingRight)
        const width = Math.ceil((right - box.left + pad) * 10) / 10
        if (this.widths.get(from) !== width) {
          this.widths.set(from, width)
          changed = true
        }
      }
    }
    return changed
  }

  /** Draws the new widths, in an update of their own (a measure may not dispatch). */
  private redraw() {
    queueMicrotask(() => {
      if (this.view.plugin(unwrapper) === this)
        this.view.dispatch({ effects: widthsMeasured.of(null) })
    })
  }
}

const unwrapper: ViewPlugin<Unwrapper> = ViewPlugin.fromClass(Unwrapper, {
  decorations: (p) => p.decorations,
})

/**
 * Line Start and Line End on a line that does not wrap go to its real start
 * and end, not to the edge of the visible part (a line scrolled sideways
 * reaches past the editor). At the start, the first press stops after the
 * indentation, as on a wrapped line.
 */
function lineBoundary(forward: boolean, extend: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view
    const head = state.selection.main.head
    const line = state.doc.lineAt(head)
    const start = view.coordsAtPos(line.from, 1)
    const end = view.coordsAtPos(line.to, -1)
    // A wrapped line (start and end on different rows) keeps the usual keys.
    if (!start || !end || Math.abs(start.top - end.top) > 1) return false
    view.dispatch(
      state.update({
        selection: EditorSelection.create(
          state.selection.ranges.map((range) => {
            const at = state.doc.lineAt(range.head)
            let to = forward ? at.to : at.from
            if (!forward) {
              const indent = /^\s*/.exec(at.text)?.[0].length ?? 0
              if (range.head !== at.from + indent) to = at.from + indent
            }
            return extend ? EditorSelection.range(range.anchor, to) : EditorSelection.cursor(to)
          }),
          state.selection.mainIndex,
        ),
        scrollIntoView: true,
        userEvent: 'select',
      }),
    )
    return true
  }
}

const boundaryKeys: KeyBinding[] = [
  { key: 'Home', run: lineBoundary(false, false), shift: lineBoundary(false, true) },
  { key: 'End', run: lineBoundary(true, false), shift: lineBoundary(true, true) },
  { mac: 'Cmd-ArrowLeft', run: lineBoundary(false, false), shift: lineBoundary(false, true) },
  { mac: 'Cmd-ArrowRight', run: lineBoundary(true, false), shift: lineBoundary(true, true) },
]

/**
 * The unwrapped lines' look: whole, as wide as their block's widest line
 * (at least the editor's width), so a block's box has straight sides.
 */
const theme = EditorView.theme({
  '.cm-line.cm-unwrap': {
    whiteSpace: 'pre',
    wordBreak: 'normal',
    overflowWrap: 'normal',
    boxSizing: 'border-box',
    minWidth: '100%',
    width: `var(${WIDTH_VAR}, auto)`,
  },
})

/** What a line wrapping mode adds to the editor. Made once, so reconfiguring with the same mode changes nothing. */
export const wrappingModes = {
  off: [caretKeeper],
  all: [EditorView.lineWrapping, caretKeeper],
  prose: [
    EditorView.lineWrapping,
    unwrapMode.of('all'),
    caretKeeper,
    unwrapper,
    theme,
    Prec.high(keymap.of(boundaryKeys)),
  ],
  unwrapAtCursor: [
    EditorView.lineWrapping,
    unwrapMode.of('active'),
    caretKeeper,
    unwrapper,
    theme,
    Prec.high(keymap.of(boundaryKeys)),
  ],
} as const
