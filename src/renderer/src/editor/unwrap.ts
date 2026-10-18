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
import { BOX_HANG } from './boxes'

/** Which blocks keep their lines whole: all of them, the one under the caret, or none. */
export const unwrapMode = Facet.define<'all' | 'active' | null, 'all' | 'active' | null>({
  combine: (values) => values[0] ?? null,
})

/** A block that does not wrap: where it starts and ends, and the start of each of its lines asked for. */
export interface UnwrapBlock {
  from: number
  to: number
  lines: number[]
}

type Ranges = readonly { from: number; to: number }[]

const BLOCKS = new Set(['FencedCode', 'CodeBlock', 'Table'])

/**
 * Whether `node` is a code block or a table outside any quote (an alert is
 * a quote). A fence still waiting for its closing one is not a block yet:
 * it would take the rest of the note with it.
 */
function unwrappable(node: SyntaxNode): boolean {
  if (!BLOCKS.has(node.name)) return false
  if (node.name === 'FencedCode' && node.getChildren('CodeMark').length < 2) return false
  for (let up = node.parent; up; up = up.parent) if (up.name === 'Blockquote') return false
  return true
}

/** A block's extent, with the starts of its lines that are in `ranges`. */
function linesOf(state: EditorState, node: SyntaxNode, ranges: Ranges): UnwrapBlock {
  const { doc } = state
  const first = doc.lineAt(node.from)
  // A node can end at the start of the next line: that line is not in it.
  const end = doc.lineAt(node.to)
  const last = end.from === node.to && end.number > first.number ? doc.line(end.number - 1) : end
  const lines: number[] = []
  let after = -1
  for (const range of ranges) {
    const from = Math.max(first.from, range.from)
    const to = Math.min(last.to, range.to)
    if (from > to) continue
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
      const start = doc.line(n).from
      if (start > after) lines.push(start)
      after = start
    }
  }
  return { from: first.from, to: last.to, lines }
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
export function unwrapLines(state: EditorState, ranges: Ranges): UnwrapBlock[] {
  const mode = state.facet(unwrapMode)
  if (mode === 'active') {
    const block = activeBlock(state)
    return block ? [linesOf(state, block, ranges)] : []
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
          out.push(linesOf(state, node.node, ranges))
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
/** Input that lets go of the caret's line; any scroll by someone else does too. */
const RELEASE_EVENTS = ['touchstart', 'pointerdown', 'keydown'] as const

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

/** The box that scrolls the lines sideways: the content itself in the reading column, else the editor's scroller. */
function sidewaysScroller(view: EditorView): HTMLElement {
  const content = view.contentDOM
  return getComputedStyle(content).overflowX === 'auto' ? content : view.scrollDOM
}

/** Scrolls the lines sideways so the caret box (`caret`, in screen pixels) is inside the scroller's edges. */
export function revealSideways(
  view: EditorView,
  caret: { left: number; right: number },
  margin = 0,
) {
  const scroller = sidewaysScroller(view)
  const box = scroller.getBoundingClientRect()
  if (caret.left < box.left + margin) scroller.scrollLeft -= box.left + margin - caret.left
  else if (caret.right > box.right - margin) scroller.scrollLeft += caret.right - box.right + margin
}

/** After the caret moves or text changes, keeps the caret inside the sideways scroller. */
export const keepCaretInColumn = ViewPlugin.fromClass(
  class {
    // The editor redraws its cursor and selection layers on its own scroller's
    // scroll only, so a sideways scroll of the column asks for a redraw too.
    private readonly redraw = () => this.view.requestMeasure()

    constructor(private readonly view: EditorView) {
      view.contentDOM.addEventListener('scroll', this.redraw)
    }

    destroy() {
      this.view.contentDOM.removeEventListener('scroll', this.redraw)
    }

    update(update: ViewUpdate) {
      if (!update.selectionSet && !update.docChanged) return
      const view = update.view
      view.requestMeasure({
        key: this,
        read: (v) => {
          if (sidewaysScroller(v) !== v.contentDOM) return null
          return v.coordsAtPos(v.state.selection.main.head)
        },
        write: (caret, v) => {
          if (caret) revealSideways(v, caret, CARET_MARGIN)
        },
      })
    }
  },
)
const CARET_MARGIN = 8

/**
 * Keeps the caret's line at its screen position across a rewrap: `hold`
 * reads where it is (before the editor draws the change), then each round
 * scrolls it back. A click, a key, any later edit or caret move, or a
 * scroll this did not make (the user's, or the editor bringing the caret
 * into view) lets go.
 */
class CaretKeeper {
  private held: { head: number; offset: number; scroller: HTMLElement } | null = null
  private scroller: HTMLElement | null = null
  /** Where this last left the scroll box: a scroll to anywhere else is someone else's. */
  private expected = 0
  private rounds = 0
  private started = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly release = () => this.letGo()
  private readonly scrolled = () => {
    if (this.held && Math.abs(this.held.scroller.scrollTop - this.expected) > 1) this.letGo()
  }

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate) {
    const asked = update.transactions.some((tr) => tr.effects.some((e) => e.is(keepCaretLine)))
    if (asked) this.hold()
    else if (this.held && (update.docChanged || update.selectionSet)) this.letGo()
  }

  /** Notes where the caret's line is; call before the change is drawn. */
  hold() {
    const { view } = this
    if (!this.scroller?.isConnected) this.scroller = verticalScroller(view)
    const scroller = this.scroller
    const head = view.state.selection.main.head
    const offset = caretOffset(view, scroller, head)
    // A caret off screen has no place to keep.
    if (offset < 0 || offset > scroller.clientHeight) return this.letGo()
    if (!this.held) {
      for (const name of RELEASE_EVENTS) view.dom.addEventListener(name, this.release, true)
      scroller.addEventListener('scroll', this.scrolled, { passive: true })
    }
    this.held = { head, offset, scroller }
    this.expected = scroller.scrollTop
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
        return {
          held,
          drift: caretOffset(view, held.scroller, held.head) - held.offset,
          caret,
        }
      },
      write: (measured, view) => {
        if (!measured || measured.held !== this.held) return
        const { held, drift, caret } = measured
        if (Math.abs(drift) >= 0.5) held.scroller.scrollTop += drift
        this.expected = held.scroller.scrollTop
        // Once, sideways too, so a caret that ends up past an edge shows.
        if (first && caret) revealSideways(view, caret)
        this.rounds++
        clearTimeout(this.timer)
        if (this.rounds >= KEEP_ROUNDS || Date.now() - this.started >= KEEP_MS) return this.letGo()
        this.timer = setTimeout(() => this.round(false), KEEP_MS / KEEP_ROUNDS)
      },
    })
  }

  private letGo() {
    clearTimeout(this.timer)
    if (this.held) {
      for (const name of RELEASE_EVENTS) this.view.dom.removeEventListener(name, this.release, true)
      this.held.scroller.removeEventListener('scroll', this.scrolled)
    }
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
/** The CSS variable with the width the lines have on screen (a wrapped line's). */
const VIEW_VAR = '--editor-unwrap-view'

const lineDeco = (width: number | undefined, view: number | undefined) => {
  const style = [
    width === undefined ? '' : `${WIDTH_VAR}: ${width}px;`,
    view === undefined ? '' : `${VIEW_VAR}: ${view}px;`,
  ].join(' ')
  return Decoration.line({
    class: 'cm-unwrap',
    ...(style.trim() ? { attributes: { style: style.trim() } } : {}),
  })
}

/**
 * Draws the unwrapped lines on screen and measures them: each line's text
 * width (its natural one, as `white-space: pre` lays it out) plus its
 * padding, the block's width being its widest measured line's. Widths are
 * kept per line start and moved through edits, so lines scrolled out of
 * view keep theirs; an edited line, a block no longer unwrapped and a new
 * font drop theirs.
 */
class Unwrapper {
  decorations: DecorationSet = Decoration.none
  private blocks: UnwrapBlock[] = []
  private widths = new Map<number, number>()
  private viewWidth: number | undefined
  private active: number | null = null
  private font: string

  constructor(private readonly view: EditorView) {
    this.font = this.fontKey()
    this.recompute(false)
  }

  private fontKey() {
    return `${this.view.defaultCharacterWidth}/${this.view.defaultLineHeight}`
  }

  update(update: ViewUpdate) {
    if (update.docChanged) {
      const touched: [number, number][] = []
      update.changes.iterChangedRanges((fromA, toA) => touched.push([fromA, toA]))
      const moved = new Map<number, number>()
      for (const [from, width] of this.widths) {
        const line = update.startState.doc.lineAt(from)
        if (touched.some(([a, b]) => a <= line.to && b >= line.from)) continue
        moved.set(update.changes.mapPos(from), width)
      }
      this.widths = moved
    }
    if (update.geometryChanged && this.fontKey() !== this.font) {
      this.font = this.fontKey()
      this.widths.clear()
    }
    const active = update.state.facet(unwrapMode) === 'active'
    if (
      update.docChanged ||
      update.viewportChanged ||
      (update.selectionSet && active) ||
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
    const mode = view.state.facet(unwrapMode)
    this.blocks = unwrapLines(view.state, view.visibleRanges)
    if (mode === 'active') {
      const active = activeBlock(view.state)?.from ?? null
      // The keeper is set up before this plugin, so it has already let go of any older hold.
      if (active !== this.active && caretMoved) view.plugin(caretKeeper)?.hold()
      this.active = active
    }
    // Widths of blocks no longer unwrapped (or out of view, in prose) go.
    for (const from of this.widths.keys())
      if (!this.blocks.some((b) => from >= b.from && from <= b.to)) this.widths.delete(from)
    this.draw()
    if (this.blocks.some((b) => b.lines.length > 0))
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
      for (const [from, w] of this.widths)
        if (from >= block.from && from <= block.to) width = Math.max(width ?? 0, w)
      const deco = lineDeco(width, this.viewWidth)
      for (const from of block.lines) decos.push(deco.range(from))
    }
    this.decorations = Decoration.set(decos)
  }

  /** Reads the width of each unwrapped line on screen; true when any changed. */
  private measure(): boolean {
    const { view } = this
    let changed = false
    const content = getComputedStyle(view.contentDOM)
    const viewWidth =
      Math.floor(
        (view.contentDOM.clientWidth -
          parseFloat(content.paddingLeft) -
          parseFloat(content.paddingRight)) *
          10,
      ) / 10
    if (viewWidth !== this.viewWidth) {
      this.viewWidth = viewWidth
      changed = true
    }
    const range = document.createRange()
    for (const block of this.blocks) {
      for (const from of block.lines) {
        const { node } = view.domAtPos(from)
        const line = (node instanceof Element ? node : node.parentElement)?.closest('.cm-line')
        if (!(line instanceof HTMLElement) || !line.classList.contains('cm-unwrap')) continue
        const box = line.getBoundingClientRect()
        const style = getComputedStyle(line)
        // The text's right edge; widgets (a copy button in the corner) do not count.
        let right = box.left + parseFloat(style.paddingLeft)
        for (const child of line.childNodes) {
          if (child instanceof HTMLElement && child.contentEditable === 'false') continue
          if (child instanceof HTMLImageElement) continue
          range.selectNodeContents(child)
          const rect = range.getBoundingClientRect()
          if (rect.width > 0) right = Math.max(right, rect.right)
        }
        const width = Math.ceil((right - box.left + parseFloat(style.paddingRight)) * 10) / 10
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

/** Whether the line at `pos` sits on one row (it does not wrap on screen). */
function oneRow(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos)
  const start = view.coordsAtPos(line.from, 1)
  const end = view.coordsAtPos(line.to, -1)
  return start !== null && end !== null && Math.abs(start.top - end.top) <= 1
}

/**
 * Line Start and Line End on a line that does not wrap go to its real start
 * and end, not to the edge of the visible part (a line scrolled sideways
 * reaches past the editor). At the start, the first press stops after the
 * indentation. A caret on a wrapped line goes to its row's edge as usual;
 * when no caret is on an unwrapped line, the usual keys run.
 */
function lineBoundary(forward: boolean, extend: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view
    const single = state.selection.ranges.map((r) => oneRow(view, r.head))
    if (!single.some(Boolean)) return false
    view.dispatch(
      state.update({
        selection: EditorSelection.create(
          state.selection.ranges.map((range, i) => {
            let to: number
            if (single[i]) {
              const at = state.doc.lineAt(range.head)
              to = forward ? at.to : at.from
              if (!forward) {
                const indent = /^\s*/.exec(at.text)?.[0].length ?? 0
                if (range.head !== at.from + indent) to = at.from + indent
              }
            } else to = view.moveToLineBoundary(range, forward).head
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
  // The content keeps the editor's width: an unwrapped line reaches past it
  // instead of widening it (and with it every wrapped line).
  '.cm-content.cm-lineWrapping': { minWidth: '0' },
  '.cm-line.cm-unwrap': {
    whiteSpace: 'pre',
    wordBreak: 'normal',
    overflowWrap: 'normal',
    boxSizing: 'border-box',
    minWidth: '100%',
    width: `var(${WIDTH_VAR}, auto)`,
  },
  // A code block's copy button stays in the corner on screen, not at the far end of a long line.
  '.cm-line.cm-unwrap .cm-codeblock-copy': {
    right: 'auto',
    left: `calc(var(${VIEW_VAR}, 100%) - var(--space-10) - var(--space-2) + ${BOX_HANG})`,
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
