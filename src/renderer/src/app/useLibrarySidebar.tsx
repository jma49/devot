import type { RefObject } from 'react'
import type { NoteStatus, TagColor, TagColorValue } from '../../../core'
import { bookWithDescendants } from '../../../core/books'
import type { NoteFilter } from '../../../core/tags'
import { errorCode } from '../backups'
import { IMPORT_PICKS, type ImportAction } from '../bookMenu'
import type { Core } from '../core-client'
import type { ExportFailure } from '../ExportNotice'
import { IMPORT_FAILED, pickImport } from '../importer'
import type { PaletteSource } from '../palette/results'
import { Sidebar, type Selection, type SidebarMenus } from '../Sidebar'
import { useStable } from '../stable'
import type { Confirm } from './useConfirm'
import type { LibraryChanges } from './useLibraryChanges'
import type { LibraryLists } from './useLibraryLists'
import type { ViewState } from './useLibraryView'
import type { useSavedSearches } from './useSavedSearches'
import type { useViewChanges } from './useViewChanges'

const ALL_NOTES: Selection = { kind: 'all' }

/** The sidebar, with callbacks that keep their identity so saving a note does not render it again. */
export function useLibrarySidebar({
  core,
  editing,
  lists,
  view,
  viewChanges,
  libraryChanges,
  setNotesStatus,
  savedSearch,
  setConfirm,
  setExportNotice,
  exportBook,
  openPalette,
  create,
  askEmptyTrash,
  menus,
}: {
  core: Core | undefined
  editing: boolean
  lists: LibraryLists
  view: ViewState
  viewChanges: ReturnType<typeof useViewChanges>
  libraryChanges: LibraryChanges
  setNotesStatus: (ids: readonly string[], status: NoteStatus) => Promise<void>
  savedSearch: ReturnType<typeof useSavedSearches>
  setConfirm: (confirm: Confirm) => void
  setExportNotice: (notice: { failure: ExportFailure; code: string }) => void
  exportBook: (action: 'exportMarkdown' | 'exportHtml', id: string) => Promise<void>
  openPalette: (scope?: PaletteSource) => void
  create: () => Promise<void>
  askEmptyTrash: () => void
  menus: RefObject<SidebarMenus | null>
}) {
  const { notes, books, tags, templates, trash } = lists
  const { counts, workspaceNode, sidebarTree, searchingAll, libraryBook, inTrash, inTemplates } =
    view
  const { library, activeFilter, pinnedCount, statuses, agents, sidebarTags, sidebarTagged } = view
  const { sidebarWorkspace, savedSearchRows } = view
  const { showLibrary, showFilter, workspaceUp, stableOpenWorkspace } = viewChanges
  const { changeBooks, createBook, moveNotes, putTagOnNotes, trashNotes } = libraryChanges
  const { renamingBook, setRenamingBook } = libraryChanges
  const { activeSearch, runSavedSearch, sidebarRenameSavedSearch, sidebarEditSavedSearch } =
    savedSearch
  const { sidebarDeleteSavedSearch, sidebarPlaceSavedSearch } = savedSearch
  // Stable, so a Copy ID that fails does not render the Sidebar with every save.
  const sidebarCopyFailed = useStable((failure: ExportFailure, code: string) =>
    setExportNotice({ failure, code }),
  )
  const sidebarSelect = useStable((next: Selection, options?: { clearFilter?: boolean }) =>
    showLibrary(next, options),
  )
  const sidebarCreateBook = useStable((parentId: string | null) => void createBook(parentId))
  const sidebarRenameBook = useStable(
    (id: string, name: string) => void changeBooks((c) => c.renameBook(id, name)),
  )
  const sidebarRenameDone = useStable(() => setRenamingBook(undefined))
  const sidebarMoveBook = useStable(
    (id: string, parentId: string | null) => void changeBooks((c) => c.moveBook(id, parentId)),
  )
  const sidebarPlaceBook = useStable(
    (id: string, targetId: string, where: 'before' | 'after') =>
      void changeBooks((c) => c.placeBook(id, targetId, where)),
  )
  const sidebarSetAiAccess = useStable(
    (id: string, on: boolean) => void changeBooks((c) => c.setBookAiAccess(id, on)),
  )
  const sidebarSetBookIcon = useStable(
    (id: string, icon: string | null, color: TagColor | null) =>
      void changeBooks((c) => c.setBookIcon(id, icon, color)),
  )
  // Deleting a notebook asks first: it takes its sub-notebooks with it, and
  // nothing brings them back.
  const sidebarDeleteBook = useStable((id: string) => {
    const book = books.find((b) => b.id === id)
    if (!book) return
    setConfirm({
      kind: 'book',
      id,
      name: book.name,
      subs: bookWithDescendants(books, id).size - 1,
      notes: counts.get(id) ?? 0,
    })
  })
  const sidebarExportBook = useStable(
    (action: 'exportMarkdown' | 'exportHtml', id: string) => void exportBook(action, id),
  )
  const sidebarImportBook = useStable((action: ImportAction, id: string) => {
    const kind = IMPORT_PICKS[action]
    pickImport(kind, id).catch((e: unknown) => {
      const code = errorCode(e)
      console.warn('W_IMPORT_PICK_FAILED', code)
      window.dispatchEvent(new CustomEvent(IMPORT_FAILED, { detail: { id: null, code } }))
    })
  })
  const sidebarMoveNotes = useStable((ids: string[], bookId: string) => void moveNotes(ids, bookId))
  const sidebarTagNotes = useStable(
    (ids: string[], tagId: string) => void putTagOnNotes(ids, tagId),
  )
  const sidebarSetNotesStatus = useStable(
    (ids: string[], status: NoteStatus) => void setNotesStatus(ids, status),
  )
  const sidebarTrashNotes = useStable((ids: string[]) => void trashNotes(ids))
  const sidebarFilter = useStable((next: NoteFilter | null) => showFilter(next))
  const sidebarRenameTag = useStable(
    (id: string, name: string) => void changeBooks((c) => c.renameTag(id, name)),
  )
  const sidebarSetTagColor = useStable(
    (id: string, color: TagColorValue | null) => void changeBooks((c) => c.setTagColor(id, color)),
  )
  const sidebarSearchBooks = useStable(() => openPalette('book'))
  const sidebarSearchTags = useStable(() => openPalette('tag'))
  const sidebarNewNote = useStable(() => {
    if (inTrash) showLibrary({ kind: 'all' })
    void create()
  })
  const sidebarWorkspaceUp = useStable(() => workspaceUp())
  const sidebarDeleteTag = useStable((id: string) =>
    setConfirm({
      kind: 'tag',
      id,
      name: tags.find((tag) => tag.id === id)?.name ?? '',
      count: notes.filter((n) => n.tagIds.includes(id)).length,
    }),
  )
  const sidebar = (
    <Sidebar
      total={workspaceNode ? (counts.get(workspaceNode.id) ?? 0) : notes.length}
      tree={sidebarTree}
      counts={counts}
      selection={searchingAll ? null : libraryBook || inTrash || inTemplates ? library : ALL_NOTES}
      renaming={renamingBook}
      onSelect={sidebarSelect}
      onCreateBook={core && editing ? sidebarCreateBook : undefined}
      onRenameBook={sidebarRenameBook}
      onRenameDone={sidebarRenameDone}
      onMoveBook={sidebarMoveBook}
      onPlaceBook={sidebarPlaceBook}
      onSetAiAccess={sidebarSetAiAccess}
      onSetBookIcon={sidebarSetBookIcon}
      onDeleteBook={sidebarDeleteBook}
      onExportBook={sidebarExportBook}
      onImportBook={sidebarImportBook}
      onMoveNotes={sidebarMoveNotes}
      onTagNotes={sidebarTagNotes}
      onSetNotesStatus={sidebarSetNotesStatus}
      onTrashNotes={sidebarTrashNotes}
      filter={inTrash || inTemplates || searchingAll ? null : activeFilter}
      onFilter={sidebarFilter}
      pinnedCount={pinnedCount}
      statusCounts={statuses}
      agents={agents}
      tags={sidebarTags}
      tagCounts={sidebarTagged}
      onRenameTag={sidebarRenameTag}
      onSetTagColor={sidebarSetTagColor}
      onDeleteTag={sidebarDeleteTag}
      templatesCount={templates.length}
      trashCount={trash.length}
      onSearchBooks={sidebarSearchBooks}
      onSearchTags={sidebarSearchTags}
      onEmptyTrash={askEmptyTrash}
      onCopyFailed={sidebarCopyFailed}
      onNewNote={core && editing ? sidebarNewNote : undefined}
      readOnly={!editing}
      workspace={sidebarWorkspace}
      onOpenWorkspace={stableOpenWorkspace}
      onWorkspaceUp={sidebarWorkspaceUp}
      menus={menus}
      savedSearches={savedSearchRows}
      activeSearch={activeSearch}
      onRunSavedSearch={runSavedSearch}
      onRenameSavedSearch={sidebarRenameSavedSearch}
      onEditSavedSearch={sidebarEditSavedSearch}
      onDeleteSavedSearch={sidebarDeleteSavedSearch}
      onPlaceSavedSearch={sidebarPlaceSavedSearch}
    />
  )
  return { sidebar, sidebarSelect, sidebarFilter, sidebarRenameTag, sidebarSetTagColor }
}
