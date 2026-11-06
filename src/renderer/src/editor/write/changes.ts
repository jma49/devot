// What a step changed for Write mode's blocks, as spans of the new note: the
// lines an edit touched and the top-level blocks the parser read again.
// Blocks outside these are kept, moved with the text.
import { syntaxTree } from '@codemirror/language'
import type { ChangeDesc, Text, Transaction } from '@codemirror/state'
import { Tree, type TreeBuffer } from '@lezer/common'

/** From and to, both included. */
export type Span = readonly [number, number]

/** Sorted and merged, each widened to whole lines of `doc`; spans that meet become one. */
export function lineSpans(doc: Text, spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const [a, b] of sorted) {
    const from = doc.lineAt(Math.min(Math.max(a, 0), doc.length)).from
    const to = doc.lineAt(Math.min(Math.max(b, a, 0), doc.length)).to
    const prev = out[out.length - 1]
    if (prev && from <= prev[1] + 1) prev[1] = Math.max(prev[1], to)
    else out.push([from, to])
  }
  return out
}

/** Whether `span` meets any of `spans` (sorted, apart), edges included. */
export function meets(spans: readonly Span[], from: number, to: number): boolean {
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const span = spans[mid]!
    if (to < span[0]) hi = mid - 1
    else if (from > span[1]) lo = mid + 1
    else return true
  }
  return false
}

/** The index of the first of `spans` (in order, apart) that ends at or after `pos`. */
export function firstReaching(spans: readonly { to: number }[], pos: number): number {
  let lo = 0
  let hi = spans.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid]!.to < pos) lo = mid + 1
    else hi = mid
  }
  return lo
}

type Unit = Tree | TreeBuffer

/** A tree's top-level blocks in order, with the parser's balancing nodes stepped into. */
interface Units {
  units: Unit[]
  from: number[]
}

const unitsCache = new WeakMap<Tree, Units>()

function unitsOf(tree: Tree): Units {
  const known = unitsCache.get(tree)
  if (known) return known
  const out: Units = { units: [], from: [] }
  const add = (node: Tree, offset: number) => {
    for (let i = 0; i < node.children.length; i++) {
      const unit = node.children[i]!
      const at = offset + node.positions[i]!
      if (unit instanceof Tree && unit.type.isAnonymous && unit.children.length > 0) add(unit, at)
      else {
        out.units.push(unit)
        out.from.push(at)
      }
    }
  }
  add(tree, 0)
  unitsCache.set(tree, out)
  return out
}

/**
 * Whether two top-level units read the same. Code a nested language parses
 * gives its fenced block a new node on every parse, so a block is the same
 * when it is of the same kind and length: a top-level block is parsed from
 * its own text alone, and the caller checks that text is unchanged.
 */
function sameUnit(a: Unit, b: Unit): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  if (a instanceof Tree) return b instanceof Tree && !a.type.isAnonymous && a.type === b.type
  if (b instanceof Tree || a.buffer.length !== b.buffer.length) return false
  for (let i = 0; i < a.buffer.length; i++) if (a.buffer[i] !== b.buffer[i]) return false
  return true
}

/**
 * The spans of the new note whose top-level blocks differ from the old
 * tree's: a block that reads the same, untouched by the change and at the
 * place it moved the block to, is kept.
 */
function treeChanges(before: Tree, after: Tree, changes: ChangeDesc): Span[] {
  const out: Span[] = []
  const a = unitsOf(before)
  const b = unitsOf(after)
  const edits: number[] = []
  changes.iterChangedRanges((fromA, toA, _fromB, toB) => edits.push(fromA, toA, toB - toA))
  let edit = 0
  let shift = 0
  let i = 0
  let j = 0
  /** Where old unit `i` starts in the new note, or -1 when a change touches it. */
  const placed = (): number => {
    const from = a.from[i]!
    const to = from + a.units[i]!.length
    while (edit < edits.length && edits[edit + 1]! < from) {
      shift = edits[edit + 2]!
      edit += 3
    }
    return edit < edits.length && edits[edit]! <= to ? -1 : from + shift
  }
  const dropOld = () => {
    const from = a.from[i]!
    out.push([changes.mapPos(from, -1), changes.mapPos(from + a.units[i]!.length, 1)])
    i++
  }
  const dropNew = () => {
    out.push([b.from[j]!, b.from[j]! + b.units[j]!.length])
    j++
  }
  while (i < a.units.length && j < b.units.length) {
    const fa = placed()
    const fb = b.from[j]!
    if (fa === fb && sameUnit(a.units[i]!, b.units[j]!)) {
      i++
      j++
    } else if (fa < 0) dropOld()
    else if (fa < fb) dropOld()
    else if (fb < fa) dropNew()
    else {
      dropOld()
      dropNew()
    }
  }
  while (i < a.units.length) dropOld()
  while (j < b.units.length) dropNew()
  const end = changes.mapPos(before.length, 1)
  if (end !== after.length) out.push([Math.min(end, after.length), Math.max(end, after.length)])
  return out
}

/**
 * The spans of the new note a step changed: the lines its edits touched and
 * those of the blocks the parser read again, as whole lines. Null for a step
 * that may change everything (a new configuration).
 */
export function changedSpans(tr: Transaction): Span[] | null {
  if (tr.reconfigured) return null
  const spans: Span[] = []
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => spans.push([fromB, toB]))
  const before = syntaxTree(tr.startState)
  const after = syntaxTree(tr.state)
  if (before !== after) spans.push(...treeChanges(before, after, tr.changes))
  return lineSpans(tr.state.doc, spans)
}
