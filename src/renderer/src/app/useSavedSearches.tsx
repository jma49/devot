import { useState } from 'react'
import type { SavedSearchRecord, TagRecord } from '../../../core'
import type { BookNode } from '../../../core/books'
import { MAX_SAVED_SEARCH_NAME_CHARS, savedQueryText } from '../../../core/savedSearches'
import type { SearchScope } from '../../../core/search'
import { clipChars } from '../../../core/text'
import { useContextMenu, type MenuPoint } from '../contextMenu'
import type { Core } from '../core-client'
import { SavedSearchDialog } from '../SavedSearchDialog'
import { SEARCH_FIELD_MENU } from '../savedSearchMenu'
import type { Selection } from '../Sidebar'
import { useStable } from '../stable'
import type { useSearch } from '../useSearch'
import type { Confirm } from './useConfirm'

/** Saved searches: running one in the search field, saving the query typed, and editing them from the sidebar. */
export function useSavedSearches({
  search: searchState,
  searching,
  searchScope,
  savedSearches,
  tags,
  workspaceNode,
  inTrash,
  inTemplates,
  editing,
  showLibrary,
  changeBooks,
  setConfirm,
}: {
  search: ReturnType<typeof useSearch>
  searching: boolean
  searchScope: SearchScope | undefined
  savedSearches: SavedSearchRecord[]
  tags: TagRecord[]
  workspaceNode: BookNode | undefined
  inTrash: boolean
  inTemplates: boolean
  editing: boolean
  showLibrary: (next: Selection, options?: { clearFilter?: boolean }) => void
  changeBooks: (change: (c: Core) => Promise<unknown>) => Promise<void>
  setConfirm: (confirm: Confirm) => void
}) {
  const { query, setQuery, setSearchIn } = searchState
  // Save Search (no `id`) or Edit Saved Search.
  const [searchDialog, setSearchDialog] = useState<{ id?: string; name: string; query: string }>()
  const [ranSearch, setRanSearch] = useState<string>()
  // A saved search runs in the search field: over every note, or over the workspace open.
  const runSavedSearch = useStable((id: string) => {
    const search = savedSearches.find((s) => s.id === id)
    if (!search) return
    if (workspaceNode) showLibrary({ kind: 'book', id: workspaceNode.id }, { clearFilter: true })
    else if (inTrash || inTemplates) showLibrary({ kind: 'all' })
    setSearchIn(workspaceNode ? 'view' : 'all')
    setQuery(search.query)
    setRanSearch(id)
  })
  // The field runs a saved search when it holds its query over what that one searches: every note, or the workspace.
  const searchesSaved =
    searchScope === undefined
      ? !workspaceNode
      : !searchScope.filter && searchScope.bookId === (workspaceNode?.id ?? null)
  // The row clicked, while the field still holds its query; else the first row with that query.
  const typedQuery = query.trim()
  const activeSearch =
    searching && searchesSaved
      ? (
          savedSearches.find((s) => s.id === ranSearch && s.query === typedQuery) ??
          savedSearches.find((s) => s.query === typedQuery)
        )?.id
      : undefined
  const saveSearch = useStable(() => {
    const typed = query.trim()
    if (typed) {
      setSearchDialog({ name: clipChars(typed, MAX_SAVED_SEARCH_NAME_CHARS).trim(), query: typed })
    }
  })
  const sidebarEditSavedSearch = useStable((id: string) => {
    const search = savedSearches.find((s) => s.id === id)
    if (search) setSearchDialog({ id, name: search.name, query: search.query })
  })
  const sidebarRenameSavedSearch = useStable(
    (id: string, name: string) => void changeBooks((c) => c.renameSavedSearch(id, name)),
  )
  const sidebarPlaceSavedSearch = useStable(
    (id: string, targetId: string, where: 'before' | 'after') =>
      void changeBooks((c) => c.placeSavedSearch(id, targetId, where)),
  )
  const sidebarDeleteSavedSearch = useStable((id: string) =>
    setConfirm({
      kind: 'savedSearch',
      id,
      name: savedSearches.find((s) => s.id === id)?.name ?? '',
    }),
  )
  const finishSearchDialog = (change: { name: string; query: string }) => {
    const open = searchDialog
    setSearchDialog(undefined)
    if (!open) return
    const { id } = open
    // As the core will keep it, so the field and the sidebar's highlight agree with the row.
    const saved = savedQueryText(change.query, tags)
    if (id === undefined) {
      if (open.query === query.trim() && saved !== query.trim()) setQuery(saved)
      return void changeBooks((c) => c.createSavedSearch(change.name, saved))
    }
    // The search field running it follows its new query.
    if (id === activeSearch && saved !== open.query) {
      setQuery(saved)
      setRanSearch(id)
    }
    void changeBooks(async (c) => {
      await c.renameSavedSearch(id, change.name)
      await c.setSavedSearchQuery(id, saved)
    })
  }
  const showSearchFieldMenu = useContextMenu('searchField', SEARCH_FIELD_MENU, () => saveSearch())
  const openSearchFieldMenu = useStable((at: MenuPoint) => {
    if (editing) void showSearchFieldMenu({ query }, at)
  })
  const dialog = searchDialog ? (
    <SavedSearchDialog
      editing={searchDialog.id !== undefined}
      name={searchDialog.name}
      query={searchDialog.query}
      onSave={finishSearchDialog}
      onCancel={() => setSearchDialog(undefined)}
    />
  ) : null
  return {
    runSavedSearch,
    activeSearch,
    saveSearch,
    sidebarEditSavedSearch,
    sidebarRenameSavedSearch,
    sidebarPlaceSavedSearch,
    sidebarDeleteSavedSearch,
    openSearchFieldMenu,
    dialog,
  }
}
