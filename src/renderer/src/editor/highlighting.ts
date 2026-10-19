// Syntax highlighting for the editor: CodeMirror's, except that in code
// (fenced and indented blocks, inline code) each run of operator characters
// keeps one style. A code font draws `!=` or `=>` as one glyph only when its
// characters sit in one element, and some grammars style them apart (a shell
// script's `!` and `=`, C's `==` as two tokens). See core/operatorRuns.ts.
import { HighlightStyle, syntaxTree } from '@codemirror/language'
import { type EditorState, Prec, RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import type { Tree } from '@lezer/common'
import { highlightTree, type Highlighter } from '@lezer/highlight'
import { joinOperatorRuns, type StyledSpan } from '../../../core/operatorRuns'

const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode'])

/**
 * The highlighter's classes for `from`–`to`, with each operator run inside
 * code in one span (or none).
 */
export function highlightSpans(
  state: EditorState,
  highlighter: Highlighter,
  from: number,
  to: number,
  tree: Tree = syntaxTree(state),
): StyledSpan<string>[] {
  let spans: StyledSpan<string>[] = []
  highlightTree(tree, highlighter, (f, t, style) => spans.push({ from: f, to: t, style }), from, to)
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (!CODE_NODES.has(node.name)) return true
      const start = Math.max(node.from, from)
      const end = Math.min(node.to, to)
      spans = joinOperatorRuns(state.sliceDoc(start, end), start, spans, (s) => s)
      return false
    },
  })
  return spans
}

export function noteHighlighting(style: HighlightStyle): Extension {
  const marks = new Map<string, Decoration>()
  const mark = (cls: string): Decoration => {
    let deco = marks.get(cls)
    if (!deco) marks.set(cls, (deco = Decoration.mark({ class: cls })))
    return deco
  }
  const build = (view: EditorView, tree: Tree): DecorationSet => {
    if (!tree.length) return Decoration.none
    const builder = new RangeSetBuilder<Decoration>()
    for (const { from, to } of view.visibleRanges) {
      for (const span of highlightSpans(view.state, style, from, to, tree))
        builder.add(span.from, span.to, mark(span.style))
    }
    return builder.finish()
  }
  const plugin = ViewPlugin.fromClass(
    class {
      tree: Tree
      decorations: DecorationSet
      decoratedTo: number
      constructor(view: EditorView) {
        this.tree = syntaxTree(view.state)
        this.decorations = build(view, this.tree)
        this.decoratedTo = view.viewport.to
      }
      update(update: ViewUpdate): void {
        const tree = syntaxTree(update.state)
        const { viewport } = update.view
        const decoratedTo = update.changes.mapPos(this.decoratedTo, 1)
        // As CodeMirror does: while the parser is behind the viewport, map
        // the old highlighting rather than drop it.
        if (
          tree.length < viewport.to &&
          tree.type === this.tree.type &&
          decoratedTo >= viewport.to
        ) {
          this.decorations = this.decorations.map(update.changes)
          this.decoratedTo = decoratedTo
        } else if (tree !== this.tree || update.viewportChanged) {
          this.tree = tree
          this.decorations = build(update.view, tree)
          this.decoratedTo = viewport.to
        }
      }
    },
    { decorations: (v) => v.decorations },
  )
  return [style.module ? EditorView.styleModule.of(style.module) : [], Prec.high(plugin)]
}
