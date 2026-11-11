import {
  useCallback,
  useInsertionEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react'
import type { NoteFilter } from '../../../core/tags'
import { workspaceParent } from '../../../core/workspace'
import type { Selection } from '../Sidebar'
import { useStable } from '../stable'
import type { useSearch } from '../useSearch'
import type { FocusRequest } from './focusRequest'
import type { ViewState } from './useLibraryView'
import type { usePanes } from './usePanes'

const WORKSPACE_FOCUS_MS = 100
const WORKSPACE_LEAVE_FOCUS_MS = 10

export function useViewChanges({
  view,
  books,
  search,
  panes,
  setSelected,
  requestFocus,
  showLibraryRef,
}: {
  view: ViewState
  books: readonly { id: string }[]
  search: ReturnType<typeof useSearch>
  panes: ReturnType<typeof usePanes>
  setSelected: Dispatch<SetStateAction<string | undefined>>
  requestFocus: (request: FocusRequest) => void
  showLibraryRef: RefObject<
    ((next: Selection, options?: { clearFilter?: boolean }) => void) | undefined
  >
}) {
  const { workspace, setWorkspace, workspaceNode, workspaceIds, searchingAll } = view
  const { inTrash, inTemplates, tree, setFilter, setLibrary } = view
  const { setQuery, setSearchIn, setResults, askSearchField } = search
  const { focusStore, setFocus } = panes
  /**
   * Every view change (sidebar, palette, New Notebook, finished import) goes through here, so the same rules apply:
   * - the search is cleared, and a search over every note, which hid the
   *   view, also drops the filter that did not show as pressed;
   * - switching between the Trash and the rest closes the open note;
   * - filters narrow the library, not Templates.
   * `clearFilter` also turns the filter off (the arrow keys in the sidebar,
   * a finished import).
   */
  const showLibrary = (next: Selection, options?: { clearFilter?: boolean }) => {
    const clearFilter = searchingAll || options?.clearFilter || next.kind === 'templates'
    // A view outside the workspace leaves it; so does a workspace no longer shown (its notebook went or moved out), on the next view change.
    if (
      workspace !== null &&
      (!workspaceNode || !(next.kind === 'book' && workspaceIds?.has(next.id)))
    ) {
      setWorkspace(null)
    }
    clearSearch()
    if ((next.kind === 'trash') !== inTrash) setSelected(undefined)
    if (clearFilter) setFilter(null)
    setLibrary(next)
  }
  const showFilter = (next: NoteFilter | null) => {
    // A search over every note hid its notebook: the filter pressed covers
    // every note (in a workspace, every note of the workspace).
    const everyNote = searchingAll || inTrash || inTemplates
    clearSearch()
    if (everyNote)
      showLibrary(workspaceNode ? { kind: 'book', id: workspaceNode.id } : { kind: 'all' })
    setFilter(next)
  }
  const firstNoteWanted = useRef(false)
  const openWorkspace = (id: string) => {
    if (!books.some((b) => b.id === id)) return
    showLibraryRef.current?.({ kind: 'book', id }, { clearFilter: true })
    setWorkspace(id)
    firstNoteWanted.current = true
    setTimeout(() => requestFocus({ kind: 'area', area: 'sidebar' }), WORKSPACE_FOCUS_MS)
  }
  const firstNoteDone = () => {
    firstNoteWanted.current = false
  }
  const leaveWorkspace = () => {
    setWorkspace(null)
    setTimeout(() => requestFocus({ kind: 'area', area: 'sidebar' }), WORKSPACE_LEAVE_FOCUS_MS)
  }
  const workspaceUp = () => {
    if (!workspaceNode) return
    const parent = workspaceParent(tree, workspaceNode.id)
    if (parent === null) leaveWorkspace()
    else openWorkspace(parent)
  }
  useInsertionEffect(() => {
    showLibraryRef.current = showLibrary
  })
  // Typing a search in the Trash or Templates leaves it: neither is searched.
  const changeQuery = (next: string) => {
    if ((inTrash || inTemplates) && next.trim()) {
      if (inTrash) setSelected(undefined)
      setLibrary({ kind: 'all' })
      setWorkspace(null)
      setSearchIn('all')
    }
    // With no query the old results go: typing again must not show them
    // while the new search runs.
    if (!next.trim()) setResults(undefined)
    setQuery(next)
  }
  function clearSearch() {
    setResults(undefined)
    setQuery('')
    setSearchIn('view')
  }
  // Search shortcuts focus the field from anywhere (Shift+Cmd+F: current view, Shift+Opt+Cmd+F: every note); results need the list, so they leave focus mode first.
  const startSearch = useCallback(
    (where: 'all' | 'view') => {
      focusStore.save(false)
      setFocus(false)
      setSearchIn(where)
      askSearchField()
    },
    [focusStore, setFocus, setSearchIn, askSearchField],
  )
  const stableOpenWorkspace = useStable((id: string) => openWorkspace(id))

  return {
    showLibrary,
    showFilter,
    firstNoteWanted,
    firstNoteDone,
    openWorkspace,
    leaveWorkspace,
    workspaceUp,
    changeQuery,
    clearSearch,
    startSearch,
    stableOpenWorkspace,
  }
}
