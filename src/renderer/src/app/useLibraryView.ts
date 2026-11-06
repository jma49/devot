import { useEffect, useMemo, useRef, useState } from 'react'
import type { NoteStatus } from '../../../core'
// Imported directly, not via the core index, to keep the preview pipeline out of the main bundle.
import {
  bookCounts,
  bookWithDescendants,
  buildBookTree,
  TEMPLATES_BOOK_ID,
} from '../../../core/books'
import { countMatches, savedSearchQuery } from '../../../core/savedSearches'
import { highlightTerms, parseSearch, searchPattern, type SearchScope } from '../../../core/search'
import {
  filterNotes,
  noteGroups,
  statusCounts,
  tagCounts,
  type NoteFilter,
} from '../../../core/tags'
import { findBookNode, workspaceParents, workspaceTree } from '../../../core/workspace'
import { inNotes, useAgentWrites } from '../agentWrites'
import { writerLabel } from '../authorshipLabels'
import { boardColumns, boardOrder, boardStatuses } from '../board'
import type { Core } from '../core-client'
import { useEditorSetting } from '../editorSettings'
import { currentLocale, format, t } from '../i18n'
import {
  isBoardView,
  isGalleryView,
  layoutOf,
  type LastState,
  type ListLayout,
  type ViewLayouts,
} from '../lastState'
import type { ListSelection } from '../listSelection'
import { sameCounts, sameSearchRows } from '../listUpdates'
import { applyOrder, orderChip, orderLabel, sortLocales, sortView, useListOrder } from '../noteSort'
import { choicesFromTree, publishNotebooks, publishTemplates } from '../notebookChoices'
import { agentFilter, type Selection, type SidebarWorkspace } from '../Sidebar'
import { useKept } from '../stable'
import type { useSearch } from '../useSearch'
import type { LibraryLists } from './useLibraryLists'

/** The view the window shows (library, workspace, filter, layout, selection) and the lists, counts and names derived from it. */
export function useLibraryView({
  lastState,
  core,
  lists,
  search: searchState,
  selected,
}: {
  lastState: LastState | undefined
  core: Core | undefined
  lists: LibraryLists
  search: ReturnType<typeof useSearch>
  selected: string | undefined
}) {
  const { notes, books, tags, savedSearches, trash, trashRows, templates, authorship } = lists
  const { results, searchIn } = searchState
  const searching = searchState.query.trim() !== '' && results !== undefined
  const [library, setLibrary] = useState<Selection>(() => lastState?.view ?? { kind: 'all' })
  // Notebook open as a workspace (the sidebar shows only it); a view or note outside it, or the notebook going, leaves it.
  const [workspace, setWorkspace] = useState<string | null>(() =>
    lastState?.view.kind === 'book' ? (lastState.workspace ?? null) : null,
  )
  const [filter, setFilter] = useState<NoteFilter | null>(() =>
    lastState?.view.kind === 'templates' ? null : (lastState?.filter ?? null),
  )
  // Several notes selected (listSelection.ts); the open note stays open among them. Bound to the view it was made in (`listView`).
  const [multi, setMultiIn] = useState<{
    view: string
    selection: ListSelection
  }>()
  // The library views shown as a board (lastState.ts).
  const [layouts, setLayouts] = useState<ViewLayouts>(() => ({
    boards: lastState?.boards ?? [],
    galleries: lastState?.galleries ?? [],
  }))
  const tree = useMemo(() => buildBookTree(books), [books])
  useEffect(() => publishNotebooks(choicesFromTree(tree)), [tree])
  useEffect(
    () => publishTemplates(templates.map((n) => ({ id: n.id, title: n.title }))),
    [templates],
  )
  const counts = useKept(
    useMemo(() => bookCounts(notes, books), [notes, books]),
    sameCounts,
  )
  const libraryBook = library.kind === 'book' ? books.find((b) => b.id === library.id) : undefined
  const workspaceFound = useMemo(
    () => (workspace === null ? undefined : findBookNode(tree, workspace)),
    [tree, workspace],
  )
  const workspaceIds = useMemo(
    () => (workspaceFound ? bookWithDescendants(books, workspaceFound.id) : undefined),
    [books, workspaceFound],
  )
  const workspaceNode =
    workspaceFound && library.kind === 'book' && workspaceIds?.has(library.id)
      ? workspaceFound
      : undefined
  const inTrash = library.kind === 'trash'
  const inTemplates = library.kind === 'templates'
  const agentWrites = useAgentWrites(core, authorship)
  // In a workspace the Agents section counts only its notes, and choosing an agent lists only those.
  const workspaceNoteIds = useMemo(
    () =>
      workspaceNode && workspaceIds
        ? new Set(
            notes.filter((n) => n.bookId !== null && workspaceIds.has(n.bookId)).map((n) => n.id),
          )
        : undefined,
    [notes, workspaceNode, workspaceIds],
  )
  const agents = useMemo(
    () =>
      workspaceNoteIds
        ? inNotes(agentWrites.view, workspaceNoteIds).agents
        : agentWrites.view.agents,
    [agentWrites.view, workspaceNoteIds],
  )
  // An agent's filter takes the notes it changed from this device's rows as they are now.
  const activeFilter = useMemo(() => {
    if (inTemplates) return null
    if (filter?.kind === 'tag' && !tags.some((tag) => tag.id === filter.tagId)) return null
    if (filter?.kind !== 'agent') return filter
    const agent = agents.find((a) => a.key === filter.writer)
    return agent ? agentFilter(agent) : null
  }, [inTemplates, filter, tags, agents])
  // An agent filter whose agent is gone (its notes were trashed, or a workspace holds none of
  // them) is cleared, not only hidden: it must not turn back on by itself when the agent writes
  // again. Adjusted while rendering (React's rule for state that a change of inputs made stale),
  // so the list and the sidebar both see no filter at once.
  if (filter?.kind === 'agent' && !agents.some((agent) => agent.key === filter.writer)) {
    setFilter(null)
  }
  const listOrder = useListOrder(
    sortView({
      search: searching,
      bookId: inTemplates ? TEMPLATES_BOOK_ID : (libraryBook?.id ?? null),
      filter: activeFilter,
    }),
  )
  const order = listOrder.order
  const libraryView = `${sortView({ search: false, bookId: null, filter: activeFilter })}|${libraryBook?.id ?? ''}`
  const listView = searching
    ? `search|${JSON.stringify(results.search)}`
    : inTrash
      ? 'trash'
      : inTemplates
        ? 'templates'
        : libraryView
  const canBoard = !searching && !inTrash && !inTemplates && isBoardView(listView)
  const libraryLayout = layoutOf(layouts, libraryView)
  const boardShown = canBoard && libraryLayout === 'board'
  // A search within a view shown as a gallery shows its results as one.
  const canGallery =
    !inTrash &&
    !inTemplates &&
    isGalleryView(libraryView) &&
    (!searching || (searchIn === 'view' && libraryLayout !== 'board'))
  const galleryShown = canGallery && libraryLayout === 'gallery'
  const shownLayout: ListLayout = boardShown ? 'board' : galleryShown ? 'gallery' : 'list'
  const boardDropped = useEditorSetting('boardDropped')
  const boardStatusList = useMemo(() => boardStatuses(boardDropped), [boardDropped])
  const locales = useMemo(() => sortLocales(navigator.languages, currentLocale()), [])
  const sortButtonRef = useRef<HTMLButtonElement>(null)
  const showOrder = listOrder.show
  const sortButton = useMemo(
    () => ({
      label: format(t('sort.current'), { order: orderLabel(order) }),
      chip: orderChip(order),
      onOpen: (anchor: HTMLElement) => void showOrder(anchor),
    }),
    [order, showOrder],
  )
  const groups = useMemo(
    () =>
      noteGroups(
        applyOrder(
          filterNotes(notes, books, {
            bookId: libraryBook?.id ?? null,
            by: activeFilter,
          }),
          order,
          locales,
        ),
      ),
    [notes, books, libraryBook, activeFilter, order, locales],
  )
  // A card moved shows in its new column at once, until the lists have the change.
  const [movedTo, setMovedTo] = useState<ReadonlyMap<string, NoteStatus>>(() => new Map())
  const boardNotes = useMemo(() => {
    const listed =
      activeFilter?.kind === 'pinned' ? groups.pinned : [...groups.pinned, ...groups.others]
    if (movedTo.size === 0) return listed
    return listed.map((n) => {
      const status = movedTo.get(n.id)
      return status === undefined || status === n.status ? n : { ...n, status }
    })
  }, [groups, activeFilter, movedTo])
  const templateRows = useMemo(
    () => noteGroups(applyOrder(templates, order, locales)),
    [templates, order, locales],
  )
  const shownResults = useMemo(() => {
    const found = results?.found ?? []
    // Search looks at notes, not at this device's agent rows: an agent's view keeps to its notes here.
    const agentNotes =
      results?.search.scope && activeFilter?.kind === 'agent' ? activeFilter.noteIds : undefined
    return applyOrder(
      agentNotes ? found.filter((n) => agentNotes.has(n.id)) : found,
      order,
      locales,
    )
  }, [results, order, locales, activeFilter])
  const galleryNotes = useMemo(
    () =>
      searching
        ? shownResults
        : activeFilter?.kind === 'pinned'
          ? groups.pinned
          : [...groups.pinned, ...groups.others],
    [searching, shownResults, activeFilter, groups],
  )
  const tagsById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags])
  const sidebarNotes = useMemo(
    () =>
      workspaceNode && workspaceIds
        ? notes.filter((n) => n.bookId !== null && workspaceIds.has(n.bookId))
        : notes,
    [notes, workspaceNode, workspaceIds],
  )
  const statuses = useKept(
    useMemo(() => statusCounts(sidebarNotes), [sidebarNotes]),
    sameCounts,
  )
  const sidebarTagged = useKept(
    useMemo(() => tagCounts(sidebarNotes), [sidebarNotes]),
    sameCounts,
  )
  // Counted from the listed notes' fields, so a status or tag change shows at once; one with text has no count (only a search finds text).
  const savedSearchQueries = useMemo(() => {
    const scope = workspaceNode ? { bookId: workspaceNode.id, filter: null } : undefined
    return savedSearches.map((search) => ({
      search,
      resolved: savedSearchQuery(search, { books, tags, scope }),
    }))
  }, [savedSearches, books, tags, workspaceNode])
  const savedSearchRows = useKept(
    useMemo(
      () =>
        savedSearchQueries.map(({ search, resolved }) => ({
          id: search.id,
          name: search.name,
          count: countMatches(sidebarNotes, resolved),
        })),
      [savedSearchQueries, sidebarNotes],
    ),
    sameSearchRows,
  )
  const sidebarTags = useMemo(
    () => (workspaceNode ? tags.filter((tag) => (sidebarTagged.get(tag.id) ?? 0) > 0) : tags),
    [workspaceNode, tags, sidebarTagged],
  )
  const sidebarTree = useMemo(
    () => (workspaceNode ? workspaceTree(tree, workspaceNode.id) : tree),
    [tree, workspaceNode],
  )
  const sidebarWorkspace = useMemo<SidebarWorkspace | undefined>(
    () =>
      workspaceNode
        ? {
            book: workspaceNode,
            parents: workspaceParents(tree, workspaceNode.id),
            library: tree,
          }
        : undefined,
    [tree, workspaceNode],
  )
  const pinnedCount = useMemo(() => notes.filter((n) => n.pinned).length, [notes])
  const filterLabel =
    activeFilter === null
      ? undefined
      : activeFilter.kind === 'pinned'
        ? t('sidebar.pinned')
        : activeFilter.kind === 'status'
          ? t(`status.${activeFilter.status}`)
          : activeFilter.kind === 'agent'
            ? (() => {
                const agent = agents.find((a) => a.key === activeFilter.writer)
                return agent ? writerLabel(agent) : undefined
              })()
            : tags.find((tag) => tag.id === activeFilter.tagId)?.name
  const selectedNote =
    notes.find((n) => n.id === selected) ?? templates.find((n) => n.id === selected)
  const selectedIsTemplate = selectedNote?.bookId === TEMPLATES_BOOK_ID
  const viewName =
    filterLabel !== undefined && libraryBook
      ? format(t('search.filterInBook'), {
          filter: filterLabel,
          book: libraryBook.name,
        })
      : (filterLabel ?? libraryBook?.name ?? t('sidebar.allNotes'))
  const inView = searchIn === 'view' && !inTrash && !inTemplates
  // A search over every note shows nothing selected in the sidebar; the view returns when the search clears, and a row pressed meanwhile shows its own view.
  const searchingAll = searching && !inView
  const viewBookId = libraryBook?.id ?? null
  const searchScope = useMemo<SearchScope | undefined>(
    () =>
      inView
        ? { bookId: viewBookId, filter: activeFilter?.kind === 'agent' ? null : activeFilter }
        : undefined,
    [inView, viewBookId, activeFilter],
  )
  const resultsQuery = results?.search.query ?? ''
  const highlight = useMemo(() => {
    const terms = highlightTerms(parseSearch(resultsQuery), tags)
    return {
      title: searchPattern(terms.title),
      body: searchPattern(terms.body),
    }
  }, [resultsQuery, tags])

  const listedIds = useMemo(
    () =>
      (searching
        ? shownResults
        : inTrash
          ? trash
          : inTemplates
            ? [...templateRows.pinned, ...templateRows.others]
            : boardShown
              ? boardOrder(boardColumns(boardNotes, boardStatusList)).map((id) => ({ id }))
              : activeFilter?.kind === 'pinned'
                ? groups.pinned
                : [...groups.pinned, ...groups.others]
      ).map((n) => n.id),
    [
      searching,
      shownResults,
      inTrash,
      trash,
      inTemplates,
      templateRows,
      activeFilter,
      groups,
      boardShown,
      boardNotes,
      boardStatusList,
    ],
  )
  // Multi selection is kept to the listed notes: fewer than two is none.
  const setMulti = (selection: ListSelection | undefined) =>
    setMultiIn(selection ? { view: listView, selection } : undefined)
  const listedSet = useMemo(() => new Set(listedIds), [listedIds])
  const shownSelection = useMemo(() => {
    if (!multi || multi.view !== listView) return undefined
    const ids = multi.selection.ids.filter((id) => listedSet.has(id))
    return ids.length > 1 ? { ...multi.selection, ids } : undefined
  }, [multi, listView, listedSet])
  const multiIds = shownSelection?.ids
  // Another view starts without a selection, also when this one comes back.
  if (multi && multi.view !== listView) setMultiIn(undefined)
  const noteById = useMemo(
    () => new Map([...notes, ...templates, ...trashRows].map((n) => [n.id, n])),
    [notes, templates, trashRows],
  )
  const knownNotes = useRef(noteById)
  // oxlint-disable-next-line react/refs -- Callbacks made in this render look notes up in its lists.
  knownNotes.current = noteById
  const selectedNotes = useMemo(
    () => multiIds?.flatMap((id) => noteById.get(id) ?? []) ?? [],
    [multiIds, noteById],
  )

  return {
    searching,
    library,
    setLibrary,
    workspace,
    setWorkspace,
    filter,
    setFilter,
    layouts,
    setLayouts,
    setMultiIn,
    setMulti,
    setMovedTo,
    tree,
    counts,
    libraryBook,
    workspaceIds,
    workspaceNode,
    inTrash,
    inTemplates,
    agentWrites,
    agents,
    activeFilter,
    listOrder,
    libraryView,
    listView,
    canBoard,
    boardShown,
    canGallery,
    galleryShown,
    shownLayout,
    boardStatusList,
    locales,
    sortButtonRef,
    sortButton,
    groups,
    boardNotes,
    templateRows,
    shownResults,
    galleryNotes,
    tagsById,
    statuses,
    sidebarTagged,
    savedSearchRows,
    sidebarTags,
    sidebarTree,
    sidebarWorkspace,
    pinnedCount,
    filterLabel,
    selectedNote,
    selectedIsTemplate,
    viewName,
    inView,
    searchingAll,
    searchScope,
    highlight,
    listedIds,
    listedSet,
    shownSelection,
    multiIds,
    knownNotes,
    selectedNotes,
  }
}

export type ViewState = ReturnType<typeof useLibraryView>
