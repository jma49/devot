import { syntaxTree } from '@codemirror/language'
import {
  type EditorState,
  type Range,
  RangeSet,
  RangeSetBuilder,
  StateField,
  type Transaction,
} from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { gutterLineClass, GutterMarker } from '@codemirror/view'

/**
 * Finds the gutter markers of the syntax nodes between `from` and `to`: `mark`
 * puts a marker at the start of a line, `touch` reports each node that has
 * (or may have) markers, so a rescan can widen to the whole node.
 */
export type MarkerScan = (
  state: EditorState,
  from: number,
  to: number,
  mark: (at: number, marker: GutterMarker) => void,
  touch: (from: number, to: number) => void,
) => void

interface Markers {
  set: RangeSet<GutterMarker>
  covered: number
}

export function scanMarkers(state: EditorState, scan: MarkerScan): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>()
  scan(
    state,
    0,
    state.doc.length,
    (at, marker) => builder.add(at, at, marker),
    () => {},
  )
  return builder.finish()
}

function widen(state: EditorState, scan: MarkerScan, from: number, to: number) {
  const { doc } = state
  let a = doc.lineAt(from).from
  let b = doc.lineAt(to).to
  const touch = (f: number, t: number) => {
    a = Math.min(a, doc.lineAt(f).from)
    b = Math.max(b, doc.lineAt(t).to)
  }
  scan(state, a, b, () => {}, touch)
  return { from: a, to: b }
}

/**
 * The nodes that hold blocks: an edit in one can change the blocks inside it
 * past the lines it changed, so it is scanned whole.
 */
const CONTAINERS = new Set(['Blockquote', 'BulletList', 'OrderedList', 'ListItem'])

/**
 * The lines an edit may have changed the markers of, in the new text: the
 * lines it changed, the nodes of interest they touch in the new tree and
 * (mapped from the old) in the old one, and the top-level nodes around them
 * that the edit changed, up to the first on each side that it left as it was
 * (an opened fence takes all that follows it, until it is closed; a closed
 * front matter takes the lines before its end).
 */
function changedLines(tr: Transaction, scan: MarkerScan, fromB: number, toB: number) {
  const { state, startState, changes } = tr
  const { doc } = state
  const back = changes.invertedDesc
  const top = syntaxTree(state).topNode
  const oldTree = syntaxTree(startState)
  const kept = (n: SyntaxNode) => {
    if (CONTAINERS.has(n.name)) return false
    const from = back.mapPos(n.from, -1)
    const to = back.mapPos(n.to, 1)
    for (
      let o: SyntaxNode | null = oldTree.resolveInner(from, 1);
      o && o.from === from;
      o = o.parent
    )
      if (o.name === n.name && o.to === to && o.parent?.parent === null) return true
    return false
  }
  const region = { from: fromB, to: toB }
  /**
   * Extends the region over the top-level nodes that the edit changed: back
   * from the lines, and on from them, up to the first on each side that is as
   * it was. Nothing after a node as it was is a change; nothing after a
   * changed one may be lines the old text had.
   */
  const sync = () => {
    for (let before = region.from; ;) {
      const n = top.childBefore(before)
      if (!n) break
      if (!kept(n)) {
        region.from = Math.min(region.from, doc.lineAt(n.from).from)
        before = region.from
      } else if (n.to >= region.from) before = n.from
      else break
    }
    for (let at = region.to, last = false; ;) {
      const n = top.childAfter(at)
      if (!n) {
        if (!last) region.to = doc.length
        break
      }
      const starts = n.from >= region.from && n.from <= region.to
      if (!starts && kept(n)) {
        if (n.from > region.to) break
        at = n.to
        last = true
      } else {
        region.to = Math.max(region.to, doc.lineAt(n.to).to)
        at = region.to
        last = false
      }
    }
  }
  for (let again = true; again;) {
    const was = { ...region }
    // A node of the new tree can reach into the old text, and one of the old
    // tree into the new, so widen by both until neither reaches further.
    for (let reached = true; reached;) {
      const now = widen(state, scan, region.from, region.to)
      const old = widen(
        startState,
        scan,
        back.mapPos(now.from, -1),
        Math.max(back.mapPos(now.from, -1), back.mapPos(now.to, 1)),
      )
      const from = Math.min(now.from, doc.lineAt(changes.mapPos(old.from, -1)).from)
      const to = Math.max(now.to, doc.lineAt(changes.mapPos(old.to, 1)).to)
      reached = from < region.from || to > region.to
      region.from = Math.min(region.from, from)
      region.to = Math.max(region.to, to)
    }
    sync()
    again = region.from < was.from || region.to > was.to
  }
  return region
}

const MAX_SEPARATE_CHANGES = 50

/**
 * A field of gutter line classes that keeps up with edits and with the
 * parser instead of scanning the whole note each time: the markers move with
 * the changes, and only the lines changed, and those the parser has newly
 * reached, are scanned again (each widened to the nodes it touches).
 */
export function markerField(scan: MarkerScan): StateField<Markers> {
  return StateField.define<Markers>({
    create: (state) => ({
      set: scanMarkers(state, scan),
      covered: syntaxTree(state).length,
    }),
    update(value, tr) {
      const state = tr.state
      const end = syntaxTree(state).length
      if (tr.reconfigured) return { set: scanMarkers(state, scan), covered: end }
      if (!tr.docChanged && end <= value.covered) return value
      let { set, covered } = value
      const dirty: { from: number; to: number }[] = []
      if (tr.docChanged) {
        set = set.map(tr.changes)
        covered = tr.changes.mapPos(covered, -1)
        const changed: { from: number; to: number }[] = []
        tr.changes.iterChangedRanges((_a, _b, from, to) => changed.push({ from, to }))
        // Each range costs a pass over the changes, so a transaction of many (Replace All, a
        // format over a long selection) is taken as one span from its first change to its last.
        if (changed.length > MAX_SEPARATE_CHANGES) {
          dirty.push(changedLines(tr, scan, changed[0]!.from, changed.at(-1)!.to))
        } else for (const r of changed) dirty.push(changedLines(tr, scan, r.from, r.to))
      }
      // What the parser has reached since is new.
      if (end > covered) dirty.push(widen(state, scan, covered, end))
      covered = end
      const regions: { from: number; to: number }[] = []
      for (const r of dirty.sort((x, y) => x.from - y.from)) {
        const last = regions.at(-1)
        if (last && r.from <= last.to) last.to = Math.max(last.to, r.to)
        else regions.push({ ...r })
      }
      const added: Range<GutterMarker>[] = []
      for (const r of regions)
        scan(
          state,
          r.from,
          r.to,
          (at, marker) => {
            if (at >= r.from && at <= r.to) added.push(marker.range(at))
          },
          () => {},
        )
      set = set.update({
        filter: (from) => !regions.some((r) => from >= r.from && from <= r.to),
        add: added,
        sort: true,
      })
      return { set, covered }
    },
    provide: (field) => gutterLineClass.from(field, (value) => value.set),
  })
}
