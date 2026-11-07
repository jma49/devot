import { useMemo, type Dispatch, type SetStateAction } from 'react'
import type { TrashedNote } from '../../../core'
import type { Core } from '../core-client'
import { displayTitles, type HeadlineLoader } from '../headlines'
import type { ListSelection } from '../listSelection'
import type { TrashAction } from '../noteMenu'
import { useStable } from '../stable'
import { useTrashMenu } from '../trashMenu'
import { EmptyTrashButton } from './EmptyTrashButton'
import type { Confirm } from './useConfirm'

/** Restoring and deleting notes in the Trash, one or a selection of several. */
export function useTrash({
  editing,
  trash,
  multiIds,
  loadHeadlines,
  setConfirm,
  changeBooks,
  restoreNotes,
  setMulti,
  setSelected,
}: {
  editing: boolean
  trash: TrashedNote[]
  multiIds: readonly string[] | undefined
  loadHeadlines: HeadlineLoader | undefined
  setConfirm: (confirm: Confirm) => void
  changeBooks: (change: (c: Core) => Promise<unknown>) => Promise<void>
  restoreNotes: (ids: readonly string[]) => Promise<void>
  setMulti: (selection: ListSelection | undefined) => void
  setSelected: Dispatch<SetStateAction<string | undefined>>
}) {
  const restoreTrashed = async (id: string) => {
    await changeBooks((c) => c.restore(id))
    setSelected(undefined)
  }
  const confirmDelete = async (id: string) => {
    const note = trash.find((n) => n.id === id)
    const named = await displayTitles(loadHeadlines, [{ id, title: note?.title ?? '' }])
    setConfirm({ kind: 'one', id, title: named.get(id) ?? '' })
  }
  const trashAction = (action: TrashAction, id: string) => {
    if (!editing) return
    const many = multiIds?.includes(id) ? multiIds : undefined
    if (many) return action === 'restore' ? restoreNotes(many) : confirmDeleteMany(many)
    return action === 'restore' ? restoreTrashed(id) : confirmDelete(id)
  }
  const confirmDeleteMany = (ids: readonly string[]) => setConfirm({ kind: 'many', ids })
  const openTrashed = useStable((id: string) => {
    setMulti(undefined)
    setSelected(id)
  })
  return { restoreTrashed, trashAction, confirmDeleteMany, openTrashed }
}

/** The Trash's list: its row menu and keys, and its Empty Trash button. */
export function useTrashList({
  editing,
  trash,
  multiIds,
  trashAction,
  setConfirm,
}: {
  editing: boolean
  trash: TrashedNote[]
  multiIds: readonly string[] | undefined
  trashAction: ReturnType<typeof useTrash>['trashAction']
  setConfirm: (confirm: Confirm) => void
}) {
  const trashKey = useStable((action: TrashAction, id: string) => void trashAction(action, id))
  const askEmptyTrash = useStable(() => {
    if (trash.length > 0 && editing) setConfirm({ kind: 'empty' })
  })
  // aria-disabled, not disabled: a disabled button would drop the keyboard
  // when the Trash is emptied from it.
  const showTrashMenu = useTrashMenu((action, target) => void trashAction(action, target.id))
  const trashRowMenu = useStable(
    (id: string) =>
      void showTrashMenu({
        id,
        count: multiIds?.includes(id) ? multiIds.length : 1,
      }),
  )
  const emptyTrashButton = useMemo(
    () => <EmptyTrashButton disabled={trash.length === 0 || !editing} onClick={askEmptyTrash} />,
    [trash.length, editing, askEmptyTrash],
  )
  return { trashKey, askEmptyTrash, trashRowMenu, emptyTrashButton }
}
