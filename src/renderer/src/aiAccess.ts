// The AI access picker's logic: which notebooks it lists, which it opens
// with checked, and what applying a selection changes. Notebooks are
// independent — checking a parent never checks its sub-notebooks — because
// AI access is per notebook and a sub-notebook needs its own switch.
import type { BookNode } from '../../core/books'

/** Set in the storage both windows share, so Settings can ask the main window to open the picker. */
export const CHOOSE_AI_ACCESS = 'devot:choose-ai-access'

export interface AiAccessChange {
  id: string
  on: boolean
}

/** Every notebook in `tree`, depth first, in the order the picker lists them. */
export function notebooksInOrder(tree: readonly BookNode[]): BookNode[] {
  const out: BookNode[] = []
  const walk = (nodes: readonly BookNode[]): void => {
    for (const node of nodes) {
      out.push(node)
      walk(node.children)
    }
  }
  walk(tree)
  return out
}

/** The notebooks that allow AI access now: the picker opens with these checked. */
export function checkedNotebooks(tree: readonly BookNode[]): Set<string> {
  return new Set(
    notebooksInOrder(tree)
      .filter((node) => node.aiAccess)
      .map((node) => node.id),
  )
}

/** What applying `checked` changes, in tree order: only the notebooks whose switch differs. */
export function aiAccessChanges(
  tree: readonly BookNode[],
  checked: ReadonlySet<string>,
): AiAccessChange[] {
  return notebooksInOrder(tree)
    .filter((node) => node.aiAccess !== checked.has(node.id))
    .map((node) => ({ id: node.id, on: checked.has(node.id) }))
}

/** The change that takes back `changes`, for Undo. */
export function inverseChanges(changes: readonly AiAccessChange[]): AiAccessChange[] {
  return changes.map((change) => ({ id: change.id, on: !change.on }))
}
