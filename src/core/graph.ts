// The graph view's data: the link index between live notes as nodes and undirected edges, laid out
// once by a force simulation (Fruchterman-Reingold, with Barnes-Hut repulsion so a step costs about
// n log n, not n squared). Deterministic: the same
// links always give the same picture, so reopening the graph moves nothing.
import type { LinkGraph } from './storage'

/** Matches MAX_GRAPH_LINKS in src-tauri/src/commands/notes.rs. */
export const MAX_GRAPH_LINKS = 20_000
/** Past this many notes the graph keeps the most linked ones, and says it is capped. */
export const MAX_GRAPH_NOTES = 1_500
/** How many links away from the open note the local graph reaches. */
export const LOCAL_GRAPH_DEPTH = 2

export interface GraphNote {
  id: string
  title: string
  x: number
  y: number
  /** How many other notes it is linked with, either way. */
  links: number
}

export interface GraphView {
  notes: GraphNote[]
  /** Indices into `notes`, each pair once. */
  links: [number, number][]
  /** Notes were left out to stay within MAX_GRAPH_NOTES, or links within MAX_GRAPH_LINKS. */
  capped: boolean
}

const EDGE = 40
const GOLDEN = Math.PI * (3 - Math.sqrt(5))
// Steps times nodes stays near this, so a large graph lays out in about the time of a small one.
const WORK = 150_000
const MAX_STEPS = 300
const MIN_STEPS = 40

function neighbours(count: number, links: readonly [number, number][]): number[][] {
  const out: number[][] = Array.from({ length: count }, () => [])
  for (const [a, b] of links) {
    out[a]!.push(b)
    out[b]!.push(a)
  }
  return out
}

/** The notes `focus` reaches within `depth` links, itself first. */
function reach(start: number, around: readonly number[][], depth: number): number[] {
  const seen = new Set([start])
  let ring = [start]
  for (let step = 0; step < depth; step += 1) {
    const next: number[] = []
    for (const at of ring) {
      for (const other of around[at]!) {
        if (seen.has(other)) continue
        seen.add(other)
        next.push(other)
      }
    }
    ring = next
  }
  return [...seen]
}

/**
 * The graph to lay out: every linked note, or with `focus` the notes within LOCAL_GRAPH_DEPTH links
 * of it (the note itself even when nothing links it). `titleOf` names a note the links do not.
 */
export function graphOf(
  raw: LinkGraph,
  options: { focus?: string | undefined; focusTitle?: string; limit?: number } = {},
): Omit<GraphView, 'notes'> & { notes: Omit<GraphNote, 'x' | 'y'>[] } {
  const limit = options.limit ?? MAX_GRAPH_NOTES
  const titles = new Map(raw.notes.map((note) => [note.id, note.title]))
  const ids: string[] = []
  const index = new Map<string, number>()
  const at = (id: string) => {
    let found = index.get(id)
    if (found === undefined) {
      found = ids.length
      index.set(id, found)
      ids.push(id)
    }
    return found
  }
  const pairs = new Set<string>()
  const links: [number, number][] = []
  for (const [source, target] of raw.links) {
    const a = at(source)
    const b = at(target)
    const key = a < b ? `${a} ${b}` : `${b} ${a}`
    if (a === b || pairs.has(key)) continue
    pairs.add(key)
    links.push(a < b ? [a, b] : [b, a])
  }
  const focus = options.focus
  if (focus !== undefined && !titles.has(focus) && options.focusTitle !== undefined) {
    titles.set(focus, options.focusTitle)
  }
  const around = neighbours(ids.length, links)
  let kept: number[]
  if (focus !== undefined) {
    kept = index.has(focus) ? reach(index.get(focus)!, around, LOCAL_GRAPH_DEPTH) : []
  } else {
    kept = ids.map((_, i) => i)
  }
  let capped = raw.links.length >= MAX_GRAPH_LINKS
  if (kept.length > limit) {
    capped = true
    const head = focus !== undefined ? kept.slice(0, 1) : []
    const rest = kept
      .slice(head.length)
      .sort((a, b) => around[b]!.length - around[a]!.length || a - b)
    kept = [...head, ...rest.slice(0, limit - head.length)]
  }
  const order = [...kept].sort((a, b) => (ids[a]! < ids[b]! ? -1 : 1))
  const moved = new Map(order.map((old, i) => [old, i]))
  const notes = order.map((old) => ({
    id: ids[old]!,
    title: titles.get(ids[old]!) ?? '',
    links: 0,
  }))
  const shown: [number, number][] = []
  for (const [a, b] of links) {
    const from = moved.get(a)
    const to = moved.get(b)
    if (from === undefined || to === undefined) continue
    shown.push(from < to ? [from, to] : [to, from])
    notes[from]!.links += 1
    notes[to]!.links += 1
  }
  if (focus !== undefined && notes.length === 0) {
    notes.push({ id: focus, title: titles.get(focus) ?? '', links: 0 })
  }
  return { notes, links: shown, capped }
}

// Barnes-Hut: a cell this much wider than its distance from a node stands in for all its nodes.
const THETA2 = 0.81

/** A quadtree over the nodes, as flat arrays: each cell's mass, centre of mass, and four children. */
class Cells {
  mass: Float64Array
  cx: Float64Array
  cy: Float64Array
  size: Float64Array
  child: Int32Array
  // The node a leaf holds, or -1.
  leaf: Int32Array
  used = 0

  constructor(capacity: number) {
    this.mass = new Float64Array(capacity)
    this.cx = new Float64Array(capacity)
    this.cy = new Float64Array(capacity)
    this.size = new Float64Array(capacity)
    this.child = new Int32Array(capacity * 4)
    this.leaf = new Int32Array(capacity)
  }

  cell(size: number): number {
    const at = this.used++
    this.mass[at] = 0
    this.cx[at] = 0
    this.cy[at] = 0
    this.size[at] = size
    this.child.fill(-1, at * 4, at * 4 + 4)
    this.leaf[at] = -1
    return at
  }
}

function buildCells(cells: Cells, x: Float64Array, y: Float64Array, count: number) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < count; i += 1) {
    minX = Math.min(minX, x[i]!)
    minY = Math.min(minY, y[i]!)
    maxX = Math.max(maxX, x[i]!)
    maxY = Math.max(maxY, y[i]!)
  }
  const size = Math.max(maxX - minX, maxY - minY, 1)
  cells.used = 0
  const root = cells.cell(size)
  const originX = new Float64Array(cells.mass.length)
  const originY = new Float64Array(cells.mass.length)
  originX[root] = minX
  originY[root] = minY
  for (let i = 0; i < count; i += 1) {
    let at = root
    // Nodes in one place share a leaf past this depth rather than splitting for ever.
    for (let depth = 0; ; depth += 1) {
      const m = cells.mass[at]!
      cells.cx[at] = (cells.cx[at]! * m + x[i]!) / (m + 1)
      cells.cy[at] = (cells.cy[at]! * m + y[i]!) / (m + 1)
      cells.mass[at] = m + 1
      if (m === 0) {
        cells.leaf[at] = i
        break
      }
      if (depth > 24) break
      const half = cells.size[at]! / 2
      const place = (node: number) => {
        const qx = x[node]! >= originX[at]! + half ? 1 : 0
        const qy = y[node]! >= originY[at]! + half ? 1 : 0
        const slot = at * 4 + qx + qy * 2
        let next = cells.child[slot]!
        if (next < 0) {
          next = cells.cell(half)
          cells.child[slot] = next
          originX[next] = originX[at]! + qx * half
          originY[next] = originY[at]! + qy * half
        }
        return next
      }
      const held = cells.leaf[at]!
      if (held >= 0) {
        cells.leaf[at] = -1
        const moved = place(held)
        cells.mass[moved] = 1
        cells.cx[moved] = x[held]!
        cells.cy[moved] = y[held]!
        cells.leaf[moved] = held
      }
      at = place(i)
    }
  }
}

/** Positions for `count` nodes joined by `links`, centred on the origin, an edge about EDGE long. */
export function layoutGraph(
  count: number,
  links: readonly [number, number][],
): { x: Float64Array; y: Float64Array } {
  const x = new Float64Array(count)
  const y = new Float64Array(count)
  for (let i = 0; i < count; i += 1) {
    const r = EDGE * Math.sqrt(i + 0.5)
    x[i] = r * Math.cos(i * GOLDEN)
    y[i] = r * Math.sin(i * GOLDEN)
  }
  if (count < 2) return { x, y }
  const dx = new Float64Array(count)
  const dy = new Float64Array(count)
  const k2 = EDGE * EDGE
  const cells = new Cells(count * 4 + 16)
  const stack = new Int32Array(cells.mass.length)
  const steps = Math.max(MIN_STEPS, Math.min(MAX_STEPS, Math.floor(WORK / count)))
  let heat = EDGE * Math.sqrt(count) * 0.2
  const cool = heat / steps
  for (let step = 0; step < steps; step += 1) {
    dx.fill(0)
    dy.fill(0)
    buildCells(cells, x, y, count)
    for (let i = 0; i < count; i += 1) {
      let top = 0
      stack[top++] = 0
      while (top > 0) {
        const at = stack[--top]!
        const mass = cells.mass[at]!
        if (mass === 0 || cells.leaf[at] === i) continue
        let ex = x[i]! - cells.cx[at]!
        let ey = y[i]! - cells.cy[at]!
        let d2 = ex * ex + ey * ey
        const s = cells.size[at]!
        const leaf = cells.leaf[at]! >= 0
        if (!leaf && s * s >= THETA2 * d2) {
          for (let q = 0; q < 4; q += 1) {
            const next = cells.child[at * 4 + q]!
            if (next >= 0) stack[top++] = next
          }
          continue
        }
        if (d2 < 0.01) {
          // Two nodes in one place part along a fixed direction of their own.
          ex = (i % 13) - 6 || 1
          ey = (i % 11) - 5 || 1
          d2 = ex * ex + ey * ey
        }
        const push = (k2 * mass) / d2
        dx[i] = dx[i]! + ex * push
        dy[i] = dy[i]! + ey * push
      }
    }
    for (const [a, b] of links) {
      const ex = x[a]! - x[b]!
      const ey = y[a]! - y[b]!
      const pull = Math.sqrt(ex * ex + ey * ey) / EDGE
      dx[a] = dx[a]! - ex * pull
      dy[a] = dy[a]! - ey * pull
      dx[b] = dx[b]! + ex * pull
      dy[b] = dy[b]! + ey * pull
    }
    for (let i = 0; i < count; i += 1) {
      // Gravity keeps notes linked to nothing, and separate clusters, near the rest.
      dx[i] = dx[i]! - x[i]! * 0.01
      dy[i] = dy[i]! - y[i]! * 0.01
      const d = Math.sqrt(dx[i]! * dx[i]! + dy[i]! * dy[i]!)
      if (d === 0) continue
      const move = Math.min(d, heat) / d
      x[i] = x[i]! + dx[i]! * move
      y[i] = y[i]! + dy[i]! * move
    }
    heat = Math.max(heat - cool, 0.5)
  }
  let mx = 0
  let my = 0
  for (let i = 0; i < count; i += 1) {
    mx += x[i]!
    my += y[i]!
  }
  mx /= count
  my /= count
  for (let i = 0; i < count; i += 1) {
    x[i] = x[i]! - mx
    y[i] = y[i]! - my
  }
  return { x, y }
}

/** The graph view: `graphOf`, laid out. */
export function linkGraphView(
  raw: LinkGraph,
  options: { focus?: string | undefined; focusTitle?: string; limit?: number } = {},
): GraphView {
  const graph = graphOf(raw, options)
  const { x, y } = layoutGraph(graph.notes.length, graph.links)
  return {
    ...graph,
    notes: graph.notes.map((note, i) => ({ ...note, x: Math.round(x[i]!), y: Math.round(y[i]!) })),
  }
}
