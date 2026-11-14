// The graph sheet's camera and what lies under the pointer: pure, so the sheet's canvas code only draws.
import type { GraphNote } from '../../../core/graph'

export interface Camera {
  zoom: number
  /** Where the graph's origin is on the canvas, in CSS pixels. */
  x: number
  y: number
}

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 4
/** A note's dot, in CSS pixels at zoom 1; a much linked note's grows up to twice it. */
export const DOT = 4
/** Labels show for every note from this zoom up, or for a graph this small at any zoom. */
export const LABEL_ZOOM = 1.2
export const FEW_NOTES = 40

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

export const dotRadius = (note: Pick<GraphNote, 'links'>, most: number) =>
  DOT * (1 + (most > 0 ? Math.sqrt(note.links / most) : 0))

/** The camera that shows every note inside `width` by `height`, `margin` from the edges, never larger than zoom 1.5. */
export function fitCamera(
  notes: readonly Pick<GraphNote, 'x' | 'y'>[],
  width: number,
  height: number,
  margin: number,
): Camera {
  if (notes.length === 0) return { zoom: 1, x: width / 2, y: height / 2 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const { x, y } of notes) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  const room = (size: number) => Math.max(1, size - margin * 2)
  const zoom = clampZoom(
    Math.min(1.5, room(width) / Math.max(1, maxX - minX), room(height) / Math.max(1, maxY - minY)),
  )
  return {
    zoom,
    x: width / 2 - ((minX + maxX) / 2) * zoom,
    y: height / 2 - ((minY + maxY) / 2) * zoom,
  }
}

/** The camera zoomed by `factor` about the canvas point (`px`, `py`), which stays where it is. */
export function zoomAt(camera: Camera, factor: number, px: number, py: number): Camera {
  const zoom = clampZoom(camera.zoom * factor)
  const by = zoom / camera.zoom
  return { zoom, x: px - (px - camera.x) * by, y: py - (py - camera.y) * by }
}

export const toScreen = (camera: Camera, note: Pick<GraphNote, 'x' | 'y'>) => ({
  x: camera.x + note.x * camera.zoom,
  y: camera.y + note.y * camera.zoom,
})

/** The note whose dot is under the canvas point, the nearest when dots overlap; -1 when none is within `slop` pixels. */
export function noteAt(
  notes: readonly GraphNote[],
  camera: Camera,
  px: number,
  py: number,
  slop = 4,
): number {
  const most = notes.reduce((m, n) => Math.max(m, n.links), 0)
  let found = -1
  let best = Infinity
  for (const [i, note] of notes.entries()) {
    const at = toScreen(camera, note)
    const d = Math.hypot(at.x - px, at.y - py)
    if (d <= dotRadius(note, most) + slop && d < best) {
      best = d
      found = i
    }
  }
  return found
}

/** The notes linked with note `at`, itself included. */
export function neighbourhood(links: readonly [number, number][], at: number): Set<number> {
  const out = new Set([at])
  for (const [a, b] of links) {
    if (a === at) out.add(b)
    else if (b === at) out.add(a)
  }
  return out
}
