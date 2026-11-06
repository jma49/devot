import { useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { BatchChange } from '../../../core'
import { bookWithDescendants } from '../../../core/books'
import { errorCode } from '../backups'
import { BatchNotice } from '../BatchNotice'
import type { Core } from '../core-client'
import { t } from '../i18n'
import { saveEdits } from '../saveGuards'
import type { Selection } from '../Sidebar'
import type { LibraryLists } from './useLibraryLists'
import type { ViewState } from './useLibraryView'

/** Writes to notebooks, tags and notes that reload the lists when done, one note or several at once. */
export function useLibraryChanges({
  core,
  lists,
  view,
  showLibrary,
  showLibraryRef,
  setSelected,
  setChangeNotice,
}: {
  core: Core | undefined
  lists: LibraryLists
  view: ViewState
  showLibrary: (next: Selection, options?: { clearFilter?: boolean }) => void
  showLibraryRef: RefObject<
    ((next: Selection, options?: { clearFilter?: boolean }) => void) | undefined
  >
  setSelected: Dispatch<SetStateAction<string | undefined>>
  setChangeNotice: Dispatch<SetStateAction<string | undefined>>
}) {
  const { refresh, reloadStarted, reloadDone, books } = lists
  const { library, workspace, workspaceNode, setMulti, setMultiIn } = view
  const [renamingBook, setRenamingBook] = useState<string>()
  const [batchFailed, setBatchFailed] = useState<number>()
  /** Runs a notebook change, then reloads the lists; a refused change is logged by code and shown in a notice. */
  const changeBooks = async (change: (c: Core) => Promise<unknown>) => {
    if (!core) return
    setChangeNotice(undefined)
    reloadStarted()
    try {
      await saveEdits(core)
      await change(core).catch((e: unknown) => {
        const code = errorCode(e)
        console.warn('W_BOOK_CHANGE_FAILED', code)
        setChangeNotice(code)
      })
      // Note changes save after a short delay; write them before reloading.
      await saveEdits(core)
      await refresh(core)
    } finally {
      reloadDone()
    }
  }

  const createBook = (parentId: string | null) =>
    changeBooks(async (c) => {
      const id = await c.createBook(t('book.new'), parentId)
      showLibraryRef.current?.({ kind: 'book', id })
      setRenamingBook(id)
    })

  const deleteBook = (id: string) => {
    const family = bookWithDescendants(books, id)
    const showsGone = library.kind === 'book' && family.has(library.id)
    const workspaceGone = workspace !== null && family.has(workspace)
    return changeBooks(async (c) => {
      await c.removeBook(id)
      if (!showsGone) return
      // The notebook the view showed went: inside a workspace the view falls back to its All Notes,
      // and only the workspace's own notebook going leaves it.
      if (workspaceNode && !workspaceGone) showLibrary({ kind: 'book', id: workspaceNode.id })
      else showLibrary({ kind: 'all' })
    })
  }

  const moveNote = (noteId: string, bookId: string | null) =>
    changeBooks((c) => c.setBook(noteId, bookId))

  /** One change to several notes, note by note (each its own write); failures are logged by code and counted in a notice, the rest keep their change. Resolves to the notes whose write failed. `notice` false leaves the notice to the caller, so a move over several statuses counts all its failures once. */
  const batchFailures = async (
    ids: readonly string[],
    change: BatchChange,
    options?: { notice?: boolean },
  ): Promise<string[]> => {
    if (!core) return [...ids]
    if (ids.length === 0) return []
    const notice = options?.notice !== false
    if (notice) setBatchFailed(undefined)
    reloadStarted()
    try {
      await saveEdits(core)
      const result = await core.batch([...ids], change).catch((e: unknown) => ({
        changed: [],
        failed: ids.map((id) => ({ id, code: errorCode(e) })),
      }))
      if (result.failed.length > 0) {
        console.warn('W_BATCH_FAILED', change.kind, result.failed.length, result.failed[0]?.code)
        if (notice) setBatchFailed(result.failed.length)
      }
      await saveEdits(core)
      await refresh(core)
      return result.failed.map((f) => f.id)
    } finally {
      reloadDone()
    }
  }
  const runBatch = async (ids: readonly string[], change: BatchChange) => {
    await batchFailures(ids, change)
  }
  // Every named note gets the write even if it seems to have the value: the lists may lag a change just made (a quick second P unpins again).
  const moveNotes = (ids: readonly string[], bookId: string | null) =>
    runBatch(ids, { kind: 'book', bookId })
  const setNotesPinned = (ids: readonly string[], pinned: boolean) =>
    runBatch(ids, { kind: 'pinned', pinned })
  // A name typed is found or made; a tag picked from a list goes on by ID,
  // so it is the one picked even when two tags share its name.
  const addTagToNotes = (ids: readonly string[], name: string) =>
    runBatch(ids, { kind: 'addTag', name })
  const putTagOnNotes = (ids: readonly string[], tagId: string) =>
    runBatch(ids, { kind: 'putTag', tagId })
  const removeTagFromNotes = (ids: readonly string[], tagId: string) =>
    runBatch(ids, { kind: 'removeTag', tagId })
  const trashNotes = async (ids: readonly string[]) => {
    await runBatch(ids, { kind: 'trash' })
    setSelected((open) => (open !== undefined && ids.includes(open) ? undefined : open))
    setMultiIn((m) => (m?.selection.ids.some((id) => ids.includes(id)) ? undefined : m))
  }
  const restoreNotes = async (ids: readonly string[]) => {
    await runBatch(ids, { kind: 'restore' })
    setSelected(undefined)
    setMulti(undefined)
  }
  const batchNotice = batchFailed ? (
    <BatchNotice failed={batchFailed} onDismiss={() => setBatchFailed(undefined)} />
  ) : null

  return {
    renamingBook,
    setRenamingBook,
    setBatchFailed,
    batchNotice,
    changeBooks,
    createBook,
    deleteBook,
    moveNote,
    batchFailures,
    runBatch,
    moveNotes,
    setNotesPinned,
    addTagToNotes,
    putTagOnNotes,
    removeTagFromNotes,
    trashNotes,
    restoreNotes,
  }
}

export type LibraryChanges = ReturnType<typeof useLibraryChanges>
