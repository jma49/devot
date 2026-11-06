import { useCallback, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import { useKeymap } from '../commands/shortcutSettings'
import { titleWithKey } from '../commands/titles'
import type { MenuPoint } from '../contextMenu'
import { t } from '../i18n'
import { ToolIcon } from '../icons/Icon'
import { withLayout, type ListLayout, type ViewLayouts } from '../lastState'
import { LayoutControl } from '../LayoutControl'
import type { ListSelection } from '../listSelection'
import type { NoteAction } from '../noteMenu'
import { SearchField } from '../SearchField'
import { useStable } from '../stable'
import type { useSearch } from '../useSearch'
import type { ViewState } from './useLibraryView'

const LAYOUTS_WITH_BOARD: readonly ListLayout[] = ['list', 'board', 'gallery']
const LAYOUTS_WITHOUT_BOARD: readonly ListLayout[] = ['list', 'gallery']

function SidebarToggle({ shown, onClick }: { shown: boolean; onClick: () => void }) {
  // Re-render on keymap changes: the tooltip names the key in effect.
  useKeymap()
  return (
    <>
      <span className="window-inset" aria-hidden="true" data-tauri-drag-region />
      {/* Never part of the window's drag region, which the header around it is. */}
      <button
        type="button"
        className="tool sidebar-toggle"
        data-tauri-drag-region="false"
        aria-label={t(shown ? 'command.hideSidebar' : 'command.showSidebar')}
        title={titleWithKey(shown ? 'sidebar.hideTitle' : 'sidebar.showTitle', 'view.sidebar')}
        onClick={onClick}
      >
        <ToolIcon name="sidebar.toggle" />
      </button>
    </>
  )
}

/** Props for the memoized list and its header that keep their identity between renders, so typing in a note renders neither. */
export function useListProps({
  view,
  setLayouts,
  search,
  editing,
  sidebarShown,
  toggleSidebar,
  changeQuery,
  clearSearch,
  startSearch,
  openSearchFieldMenu,
  select,
  create,
  noteActions,
  editNote,
  changeSelection,
}: {
  view: ViewState
  setLayouts: Dispatch<SetStateAction<ViewLayouts>>
  search: ReturnType<typeof useSearch>
  editing: boolean
  sidebarShown: boolean
  toggleSidebar: () => void
  changeQuery: (next: string) => void
  clearSearch: () => void
  startSearch: (where: 'all' | 'view') => void
  openSearchFieldMenu: (at: MenuPoint) => void
  select: (id: string) => Promise<boolean>
  create: () => Promise<void>
  noteActions: {
    run: (action: NoteAction, id: string) => unknown
    menu: (id: string, at?: MenuPoint) => unknown
  }
  editNote: (part: 'title' | 'body', id: string, start?: boolean) => Promise<void>
  changeSelection: (next: ListSelection | undefined) => void
}) {
  const { canBoard, canGallery, shownLayout, listView, libraryView, inView } = view
  const { searchField, query, searchIn } = search
  const changeLayout = useStable((layout: ListLayout) =>
    setLayouts((shown) => withLayout(shown, libraryView, layout)),
  )
  const layoutKeyboard = useRef(false)
  const changeLayoutFromControl = useStable((layout: ListLayout, keyboard: boolean) => {
    layoutKeyboard.current = keyboard && layout !== shownLayout
    changeLayout(layout)
  })
  const layoutTakesKeyboard = useCallback(() => {
    const takes = layoutKeyboard.current
    layoutKeyboard.current = false
    return takes
  }, [])
  const toggleSidebarNow = useStable(toggleSidebar)
  const sidebarToggle = useMemo(
    () => <SidebarToggle shown={sidebarShown} onClick={toggleSidebarNow} />,
    [sidebarShown, toggleSidebarNow],
  )
  const changeQueryStable = useStable((next: string) => changeQuery(next))
  const clearSearchStable = useStable(() => clearSearch())
  const filterField = useMemo(
    () => (
      <SearchField
        ref={searchField}
        value={query}
        onChange={changeQueryStable}
        onClear={clearSearchStable}
        onOptions={editing ? openSearchFieldMenu : undefined}
        placeholder={inView ? t('search.placeholder') : t('search.placeholderAll')}
      />
    ),
    [
      searchField,
      query,
      inView,
      editing,
      changeQueryStable,
      clearSearchStable,
      openSearchFieldMenu,
    ],
  )
  const layoutControl = useMemo(
    () =>
      canBoard || canGallery ? (
        <LayoutControl
          layout={shownLayout}
          layouts={canBoard ? LAYOUTS_WITH_BOARD : LAYOUTS_WITHOUT_BOARD}
          view={listView}
          onChange={changeLayoutFromControl}
          takesKeyboard={layoutTakesKeyboard}
        />
      ) : undefined,
    [canBoard, canGallery, shownLayout, listView, changeLayoutFromControl, layoutTakesKeyboard],
  )
  const openFromList = useStable((id: string) => void select(id))
  const createFromList = useStable(() => void create())
  const runNoteAction = useStable((action: NoteAction, id: string) => noteActions.run(action, id))
  const showNoteMenu = useStable((id: string, at?: MenuPoint) => noteActions.menu(id, at))
  const findInView = useStable(() => startSearch('view'))
  const findEverywhere = useStable(() => startSearch('all'))
  const findAgain = useStable(() => startSearch(searchIn))
  const editFromList = useStable((part: 'title' | 'body', id: string) => void editNote(part, id))
  const changeListSelection = useStable(changeSelection)
  return {
    changeLayout,
    sidebarToggle,
    filterField,
    layoutControl,
    openFromList,
    createFromList,
    runNoteAction,
    showNoteMenu,
    findInView,
    findEverywhere,
    findAgain,
    editFromList,
    changeListSelection,
  }
}
