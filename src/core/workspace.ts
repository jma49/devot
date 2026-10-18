// A workspace: one notebook opened as the whole sidebar. It shows only that
// notebook's sub-notebooks, and the status and tag counts of its own notes
// (its sub-notebooks' included). These helpers work on the notebook tree
// (`buildBookTree`), whose parents are the effective ones.
import { flattenBookTree, notesInBook, type BookNode } from './books'
import type { BookRecord, NoteSummary } from './storage'

/** The notebook `id` in the tree, if it is there. */
export function findBookNode(tree: readonly BookNode[], id: string): BookNode | undefined {
  for (const node of tree) {
    if (node.id === id) return node
    const found = findBookNode(node.children, id)
    if (found) return found
  }
  return undefined
}

/**
 * The workspace's sub-notebooks as a tree of their own: the same notebooks,
 * with depths counted from the workspace (its children at depth 0). Empty
 * when the notebook is gone.
 */
export function workspaceTree(tree: readonly BookNode[], id: string): BookNode[] {
  const root = findBookNode(tree, id)
  if (!root) return []
  const shift = root.depth + 1
  const copy = (node: BookNode): BookNode => ({
    ...node,
    depth: node.depth - shift,
    children: node.children.map(copy),
  })
  return root.children.map(copy)
}

/** The notebooks above `id`, the top-level one first; empty for a top-level or unknown one. */
export function workspaceParents(tree: readonly BookNode[], id: string): BookNode[] {
  const byId = new Map(flattenBookTree(tree).map((n) => [n.id, n]))
  const out: BookNode[] = []
  for (let at = byId.get(id)?.parentId ?? null; at !== null;) {
    const parent = byId.get(at)
    if (!parent || out.includes(parent)) break
    out.unshift(parent)
    at = parent.parentId
  }
  return out
}

/** Where Go Up leads from the workspace `id`: its parent notebook, or null (out of workspaces). */
export function workspaceParent(tree: readonly BookNode[], id: string): string | null {
  return findBookNode(tree, id)?.parentId ?? null
}

/** The notes a workspace holds: those in the notebook and its sub-notebooks. */
export function workspaceNotes<T extends Pick<NoteSummary, 'bookId'>>(
  notes: readonly T[],
  books: readonly BookRecord[],
  id: string,
): T[] {
  return books.some((b) => b.id === id) ? notesInBook(notes, books, id) : []
}
