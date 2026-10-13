// The note list's multiple selection, as pure functions of the rows listed
// (`order`, top to bottom) and the open note.
//
// Without a selection of its own the list selects the open note. Cmd-click
// adds a row (it becomes the anchor) or takes one out; Shift-click selects
// the rows from the anchor to the clicked one; Shift+Up and Shift+Down move
// the far end of that range (the lead); Select All takes every row. The
// open note stays open while it is selected (see `openAfter`).

export interface ListSelection {
  /** The selected notes, in list order. */
  ids: readonly string[]
  /** Where a Shift range starts: the row clicked last without Shift. */
  anchor: string
  /** The far end of the range, which Shift+Up and Shift+Down move. */
  lead: string
}

const one = (id: string): ListSelection => ({ ids: [id], anchor: id, lead: id })

/** The selection to change: the list's own, else the open note alone (when listed). */
function base(
  current: ListSelection | undefined,
  open: string | undefined,
  order: readonly string[],
): ListSelection | undefined {
  if (current) {
    const listed = new Set(order)
    const ids = current.ids.filter((id) => listed.has(id))
    // An anchor or lead no longer listed falls back to a selected row.
    const anchor = listed.has(current.anchor) ? current.anchor : ids[0]
    const lead = listed.has(current.lead) ? current.lead : anchor
    if (anchor !== undefined && lead !== undefined) return { ids, anchor, lead }
  }
  return open !== undefined && order.includes(open) ? one(open) : undefined
}

const inOrder = (ids: Iterable<string>, order: readonly string[]) => {
  const set = new Set(ids)
  return order.filter((id) => set.has(id))
}

/** The rows from `a` to `b`, either way round. */
const range = (a: string, b: string, order: readonly string[]) => {
  const from = order.indexOf(a)
  const to = order.indexOf(b)
  return order.slice(Math.min(from, to), Math.max(from, to) + 1)
}

/** Cmd-click on `id`: adds it (as the anchor), or takes it out. */
export function selectToggle(
  current: ListSelection | undefined,
  open: string | undefined,
  id: string,
  order: readonly string[],
): ListSelection {
  const from = base(current, open, order)
  if (!from) return one(id)
  if (!from.ids.includes(id)) {
    return { ids: inOrder([...from.ids, id], order), anchor: id, lead: id }
  }
  // The only selected row stays selected.
  if (from.ids.length === 1) return from
  const ids = from.ids.filter((x) => x !== id)
  if (from.anchor !== id && ids.includes(from.anchor)) {
    return { ids, anchor: from.anchor, lead: from.anchor }
  }
  // The anchor moves to the nearest selected row: below, else above.
  const at = order.indexOf(id)
  const anchor =
    order.slice(at + 1).find((x) => ids.includes(x)) ??
    order.slice(0, Math.max(at, 0)).findLast((x) => ids.includes(x)) ??
    ids[0]!
  return { ids, anchor, lead: anchor }
}

/** Shift-click on `id`: the rows from the anchor to it. */
export function selectRange(
  current: ListSelection | undefined,
  open: string | undefined,
  id: string,
  order: readonly string[],
): ListSelection {
  const from = base(current, open, order)
  if (!from || !order.includes(from.anchor) || !order.includes(id)) return one(id)
  return { ids: range(from.anchor, id, order), anchor: from.anchor, lead: id }
}

/**
 * Shift+Up (-1) or Shift+Down (1): moves the lead one row and selects the
 * rows from the anchor to it. Undefined at the end of the list.
 */
export function selectStep(
  current: ListSelection | undefined,
  open: string | undefined,
  by: -1 | 1,
  order: readonly string[],
): ListSelection | undefined {
  const from = base(current, open, order)
  if (!from) return undefined
  const lead = order[order.indexOf(from.lead) + by]
  if (lead === undefined || !order.includes(from.anchor)) return undefined
  return { ids: range(from.anchor, lead, order), anchor: from.anchor, lead }
}

/** Select All: every row; the anchor stays. */
export function selectAll(
  current: ListSelection | undefined,
  open: string | undefined,
  order: readonly string[],
): ListSelection | undefined {
  const from = base(current, open, order)
  const anchor = from?.anchor ?? order[0]
  if (anchor === undefined) return undefined
  return { ids: [...order], anchor, lead: from?.lead ?? anchor }
}

/**
 * The note that is open with this selection: the open note while it is
 * selected, else the anchor, else the lead, else the last selected one.
 */
export function openAfter(selection: ListSelection, open: string | undefined): string | undefined {
  const { ids } = selection
  if (open !== undefined && ids.includes(open)) return open
  if (ids.includes(selection.anchor)) return selection.anchor
  if (ids.includes(selection.lead)) return selection.lead
  return ids.at(-1)
}
