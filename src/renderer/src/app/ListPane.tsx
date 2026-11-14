import { useMemo, type RefObject } from 'react'
import type { NoteSummary, TagColor, TagColorValue, TagRecord } from '../../../core'
import { bookIcon } from '../../../core/books'
import { BookIcon } from '../BookIcon'
import { BuiltInTemplates } from '../BuiltInTemplates'
import type { Core } from '../core-client'
import type { MenuPoint } from '../contextMenu'
import { format, t } from '../i18n'
import { Icon } from '../icons/Icon'
import { NoteBoard } from '../NoteBoard'
import { NoteGallery } from '../NoteGallery'
import { NoteList } from '../NoteList'
import { fittedBoardWidth } from '../paneWidth'
import { STATUSES, type SidebarMenus } from '../Sidebar'
import { tagColorClass, tagColorStyle } from '../tagColorStyle'
import type { SearchResults } from '../useSearch'
import type { ListLoaders } from './listLoaders'
import type { useBoardMoves } from './useBoardMoves'
import type { LibraryLists } from './useLibraryLists'
import type { ViewState } from './useLibraryView'
import type { useListProps } from './useListProps'
import type { useNoteMaking } from './useNoteMaking'
import type { NoteOpening } from './useNoteOpening'
import type { useTrashList } from './useTrash'

// Stable identity so the memoized list and sidebar skip equal props.
const NO_NOTES: NoteSummary[] = []
const NO_TAGS: ReadonlyMap<string, TagRecord> = new Map()

/** The list column: search results, the Trash, Templates, a board, a gallery or the notes of the view. */
export function ListPane({
  core,
  editing,
  selected,
  results,
  activeSearch,
  lists: { savedSearches, trashRows, tags },
  view,
  listProps,
  opening: { switching, openingId },
  loaders: { loadHeadlines, loadDetails, loadTaskCounts, loadCardPreviews, loadStrips },
  board: { moveCards, stepCards, undoMove, redoMove },
  trashList: { trashKey, trashRowMenu, emptyTrashButton },
  openTrashed,
  making: { shownBuiltIn, showBuiltIn },
  sidebarMenus,
}: {
  core: Core | undefined
  editing: boolean
  selected: string | undefined
  results: SearchResults | undefined
  activeSearch: string | undefined
  lists: LibraryLists
  view: ViewState
  listProps: ReturnType<typeof useListProps>
  opening: NoteOpening
  loaders: ListLoaders
  board: ReturnType<typeof useBoardMoves>
  trashList: ReturnType<typeof useTrashList>
  openTrashed: (id: string) => void
  making: ReturnType<typeof useNoteMaking>
  sidebarMenus: RefObject<SidebarMenus | null>
}) {
  const { galleryShown, listView, searching, filterLabel, libraryBook, activeFilter, viewName } =
    view
  const { galleryNotes, sortButton, sortButtonRef, shownSelection, highlight, shownResults } = view
  const { shownRelated } = view
  const { tagsById, agentWrites, inTrash, templateRows, inTemplates, boardShown, boardNotes } = view
  const { boardStatusList, groups } = view
  const { sidebarToggle, filterField, layoutControl, openFromList, createFromList } = listProps
  const { runNoteAction, showNoteMenu, findInView, findEverywhere, findAgain } = listProps
  const { editFromList, changeListSelection } = listProps
  const filterTag =
    activeFilter?.kind === 'tag' ? tags.find((tag) => tag.id === activeFilter.tagId) : undefined
  const shownBookIcon = libraryBook ? bookIcon(libraryBook) : undefined
  const iconKey =
    activeFilter?.kind === 'tag'
      ? `tag:${filterTag?.color ?? ''}`
      : activeFilter?.kind === 'status'
        ? `status:${activeFilter.status}`
        : activeFilter?.kind === 'pinned'
          ? 'pinned'
          : activeFilter?.kind === 'agent'
            ? 'agent'
            : shownBookIcon
              ? `book:${shownBookIcon.iconColor ?? ''}:${shownBookIcon.icon ?? ''}`
              : ''
  const listIcon = useMemo(() => {
    // The rest is a stored notebook icon, which can hold a colon itself (`lucide:leaf`).
    const [kind, a, ...rest] = iconKey.split(':')
    if (kind === 'tag') {
      const color = (a || null) as TagColorValue | null
      return (
        <span
          className={`headline-dot${color ? ` ${tagColorClass(color)}` : ''}`}
          style={tagColorStyle(color)}
        />
      )
    }
    if (kind === 'status') {
      const icon = STATUSES.find((s) => s.status === a)?.icon ?? 'status.none'
      return <Icon name={icon} size="title" />
    }
    if (kind === 'pinned') return <Icon name="notes.pinned" size="title" />
    if (kind === 'agent') return <Icon name="notebook.ai" size="title" />
    if (kind === 'book')
      return (
        <BookIcon
          icon={rest.join(':') || null}
          color={(a || null) as TagColor | null}
          size="title"
        />
      )
    return null
  }, [iconKey])
  const menuKey =
    activeFilter?.kind === 'tag'
      ? `tag:${activeFilter.tagId}`
      : !activeFilter && libraryBook
        ? `book:${libraryBook.id}`
        : ''
  const listTitleMenu = useMemo(() => {
    const [kind, id] = menuKey.split(/:(.*)/s)
    if (!kind || !id) return undefined
    return (at: MenuPoint) =>
      kind === 'tag' ? sidebarMenus.current?.tag(id, at) : sidebarMenus.current?.book(id, at)
  }, [menuKey, sidebarMenus])

  return galleryShown ? (
    <NoteGallery
      editing={editing}
      view={listView}
      title={
        searching
          ? (savedSearches.find((s) => s.id === activeSearch)?.name ?? t('search.results'))
          : (filterLabel ?? libraryBook?.name ?? t('sidebar.allNotes'))
      }
      icon={searching ? undefined : listIcon}
      onTitleMenu={searching ? undefined : listTitleMenu}
      empty={searching ? 'search' : activeFilter ? 'filter' : libraryBook ? 'notebook' : 'all'}
      filter={filterField}
      scope={
        searching
          ? format(t('search.in'), { view: viewName })
          : filterLabel !== undefined
            ? libraryBook?.name
            : undefined
      }
      notes={galleryNotes}
      tags={tagsById}
      changedBy={agentWrites.view.changedBy}
      fittedWidth={fittedBoardWidth(boardStatusList.length)}
      capped={searching && (results?.capped ?? false)}
      selected={selected}
      opening={switching ? openingId : undefined}
      onSelect={openFromList}
      onCreate={core && editing ? createFromList : undefined}
      onAction={runNoteAction}
      onMenu={showNoteMenu}
      sort={sortButton}
      sortButtonRef={sortButtonRef}
      layout={layoutControl}
      onFind={searching ? findAgain : findInView}
      onEdit={editFromList}
      leading={sidebarToggle}
      selection={shownSelection}
      onSelection={changeListSelection}
      headlines={loadHeadlines}
      taskCounts={loadTaskCounts}
      previews={loadCardPreviews}
      draggable={editing}
    />
  ) : searching ? (
    <NoteList
      editing={editing}
      view={listView}
      title={savedSearches.find((s) => s.id === activeSearch)?.name ?? t('search.results')}
      filter={filterField}
      scope={results?.search.scope ? format(t('search.in'), { view: viewName }) : undefined}
      highlight={highlight}
      onFind={findAgain}
      empty="search"
      pinned={NO_NOTES}
      notes={shownResults}
      related={shownRelated}
      capped={results?.capped ?? false}
      tags={tagsById}
      selected={selected}
      opening={switching ? openingId : undefined}
      onSelect={openFromList}
      onCreate={core && editing ? createFromList : undefined}
      onAction={runNoteAction}
      onMenu={showNoteMenu}
      sort={sortButton}
      sortButtonRef={sortButtonRef}
      onEdit={editFromList}
      leading={sidebarToggle}
      selection={shownSelection}
      onSelection={changeListSelection}
      headlines={loadHeadlines}
      details={loadDetails}
      activity={loadStrips}
      changedBy={agentWrites.view.changedBy}
      drag={editing ? 'notes' : false}
    />
  ) : inTrash ? (
    <NoteList
      editing={editing}
      view={listView}
      title={t('sidebar.trash')}
      icon={<Icon name="trash" size="title" />}
      empty="trash"
      filter={filterField}
      pinned={NO_NOTES}
      notes={trashRows}
      tags={NO_TAGS}
      selected={selected}
      onSelect={openTrashed}
      onCreate={undefined}
      selection={shownSelection}
      onSelection={changeListSelection}
      headlines={loadHeadlines}
      details={loadDetails}
      drag={false}
      onFind={findEverywhere}
      onTrashAction={trashKey}
      onMenu={trashRowMenu}
      leading={sidebarToggle}
      headerAction={emptyTrashButton}
    />
  ) : inTemplates ? (
    <NoteList
      editing={editing}
      view={listView}
      title={t('sidebar.templates')}
      icon={<Icon name="templates" size="title" />}
      empty="templates"
      filter={filterField}
      pinned={templateRows.pinned}
      notes={templateRows.others}
      tags={tagsById}
      selected={selected}
      opening={switching ? openingId : undefined}
      onSelect={openFromList}
      onCreate={core && editing ? createFromList : undefined}
      createLabel={t('templates.new')}
      onAction={runNoteAction}
      onMenu={showNoteMenu}
      sort={sortButton}
      sortButtonRef={sortButtonRef}
      onFind={findEverywhere}
      onEdit={editFromList}
      leading={sidebarToggle}
      selection={shownSelection}
      onSelection={changeListSelection}
      headlines={loadHeadlines}
      details={loadDetails}
      drag={editing ? 'templates' : false}
      after={<BuiltInTemplates selected={shownBuiltIn} onSelect={showBuiltIn} />}
    />
  ) : boardShown ? (
    <NoteBoard
      editing={editing}
      view={listView}
      title={filterLabel ?? libraryBook?.name ?? t('sidebar.allNotes')}
      icon={listIcon}
      onTitleMenu={listTitleMenu}
      empty={activeFilter ? 'filter' : libraryBook ? 'notebook' : 'all'}
      filter={filterField}
      scope={filterLabel !== undefined ? libraryBook?.name : undefined}
      notes={boardNotes}
      statuses={boardStatusList}
      tags={tagsById}
      changedBy={agentWrites.view.changedBy}
      selected={selected}
      opening={switching ? openingId : undefined}
      onSelect={openFromList}
      onCreate={core && editing ? createFromList : undefined}
      onAction={runNoteAction}
      onMenu={showNoteMenu}
      sort={sortButton}
      sortButtonRef={sortButtonRef}
      layout={layoutControl}
      onFind={findInView}
      onEdit={editFromList}
      leading={sidebarToggle}
      selection={shownSelection}
      onSelection={changeListSelection}
      headlines={loadHeadlines}
      taskCounts={loadTaskCounts}
      onMove={editing ? moveCards : undefined}
      onStep={editing ? stepCards : undefined}
      onUndo={undoMove}
      onRedo={redoMove}
    />
  ) : (
    <NoteList
      editing={editing}
      view={listView}
      title={filterLabel ?? libraryBook?.name ?? t('sidebar.allNotes')}
      icon={listIcon}
      onTitleMenu={listTitleMenu}
      empty={activeFilter ? 'filter' : libraryBook ? 'notebook' : 'all'}
      filter={filterField}
      scope={filterLabel !== undefined ? libraryBook?.name : undefined}
      pinned={activeFilter?.kind === 'pinned' ? NO_NOTES : groups.pinned}
      notes={activeFilter?.kind === 'pinned' ? groups.pinned : groups.others}
      tags={tagsById}
      selected={selected}
      opening={switching ? openingId : undefined}
      onSelect={openFromList}
      onCreate={core && editing ? createFromList : undefined}
      onAction={runNoteAction}
      onMenu={showNoteMenu}
      sort={sortButton}
      sortButtonRef={sortButtonRef}
      layout={layoutControl}
      onFind={findInView}
      onEdit={editFromList}
      leading={sidebarToggle}
      selection={shownSelection}
      onSelection={changeListSelection}
      headlines={loadHeadlines}
      details={loadDetails}
      activity={loadStrips}
      changedBy={agentWrites.view.changedBy}
      drag={editing ? 'notes' : false}
    />
  )
}
