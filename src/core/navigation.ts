// Moving between notes: the trail of notes a window opened (Back and Forward), and the note before or after the open one in a list.

export interface Trail {
  readonly ids: readonly string[]
  readonly at: number
}

export const EMPTY_TRAIL: Trail = { ids: [], at: -1 }

export const TRAIL_LIMIT = 100

/** Opening a note drops the entries ahead of the current one. */
export function visit(trail: Trail, id: string, limit = TRAIL_LIMIT): Trail {
  if (trail.ids[trail.at] === id) return trail
  const ids = [...trail.ids.slice(0, trail.at + 1), id].slice(-limit)
  return { ids, at: ids.length - 1 }
}

export function trailTo(trail: Trail, at: number): Trail {
  return { ids: trail.ids, at }
}

/** When the open note is not the current entry (a note in the Trash is shown, or none), going back starts at the current entry itself. */
export function stepTarget(
  trail: Trail,
  step: -1 | 1,
  where: { live: (id: string) => boolean; current: string | undefined },
): number | undefined {
  const onCurrent = trail.ids[trail.at] === where.current
  const start = step < 0 && !onCurrent ? trail.at : trail.at + step
  for (let i = start; i >= 0 && i < trail.ids.length; i += step) {
    const id = trail.ids[i]!
    if (id !== where.current && where.live(id)) return i
  }
  return undefined
}

export function adjacentNote(
  ids: readonly string[],
  current: string | undefined,
  step: -1 | 1,
): string | undefined {
  const at = current === undefined ? -1 : ids.indexOf(current)
  if (at < 0) return step > 0 ? ids[0] : ids[ids.length - 1]
  return ids[at + step]
}
