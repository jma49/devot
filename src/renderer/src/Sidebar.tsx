import { memo, useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { flattenBookTree } from '../../core/books'
import { t } from './i18n'
import { useKeymap } from './commands/shortcutSettings'
import { watchScrollEdges } from './scrollEdge'
import { Icon } from './icons/Icon'
import { usePaneResize } from './paneResize'
import { SIDEBAR_PANE } from './paneWidth'
import { SidebarFooter } from './SidebarFooter'
import { slideIn } from './reveal'
import { useRowMotion } from './rowMotion'
import { currentSectionStore } from './sidebarSections'
import { bookNode } from './sidebar/bookTree'
import { sidebarDialogs } from './sidebar/dialogs'
import { agentsSection, filterRow, tagsSection } from './sidebar/filterSections'
import { format, libraryRow, STATUSES, type Selection, type SidebarProps } from './sidebar/model'
import { savedSearchesSection } from './sidebar/savedSearches'
import { sectionHeader } from './sidebar/sectionHeader'
import { useDrops } from './sidebar/useDrops'
import { useFolds } from './sidebar/useFolds'
import { keepFocusOnMenu, useMenus } from './sidebar/useMenus'
import { useRowKeys } from './sidebar/useRowKeys'
import { useRowElements, type SidebarView } from './sidebar/view'
import { workspaceTitle } from './sidebar/workspaceTitle'

export { agentFilter, STATUSES } from './sidebar/model'
export type { Selection, SidebarMenus, SidebarSavedSearch, SidebarWorkspace } from './sidebar/model'
export { stepSidebarRow } from './sidebar/useRowKeys'

/** Renders again only when its props change: its owner keeps them the same while nothing it shows changes (typing in a note renders no sidebar). */
export const Sidebar = memo(function Sidebar(props: SidebarProps) {
  useKeymap()
  const { width: sidebarWidth, edge: resizeEdge } = usePaneResize(SIDEBAR_PANE)
  const { tree, selection, renaming } = props
  const ws = props.workspace
  const allSelection: Selection = ws ? { kind: 'book', id: ws.book.id } : { kind: 'all' }
  const allKey = libraryRow(allSelection).key
  const nav = useRef<HTMLElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => (scroller.current ? watchScrollEdges(scroller.current) : undefined), [])
  const shownWorkspace = useRef(ws?.book.id)
  useEffect(() => {
    const before = shownWorkspace.current
    shownWorkspace.current = ws?.book.id
    if (before === ws?.book.id || !nav.current) return
    const deeper =
      ws !== undefined && (before === undefined || ws.parents.some((p) => p.id === before))
    slideIn(
      nav.current.querySelectorAll(':scope > :is(.sidebar-workspace, .sources, .sidebar-scroll)'),
      deeper ? 1 : -1,
    )
  })
  const motionKeys = useMemo(
    () => [
      ...flattenBookTree(tree).map((n) => `book:${n.id}`),
      ...(props.savedSearches ?? []).map((s) => `search:${s.id}`),
      ...props.tags.map((tag) => `tag:${tag.id}`),
    ],
    [tree, props.savedSearches, props.tags],
  )
  const sidebarElement = () => nav.current
  useRowMotion(sidebarElement, 'data-motion-key', motionKeys, ws?.book.id ?? '', 'slide')
  const sections = useMemo(() => props.sectionStore ?? currentSectionStore(), [props.sectionStore])
  const folds = useFolds(sections)
  const { folded, revealed } = folds
  const drops = useDrops(props, folds.collapsed)
  const elements = useRowElements()
  const { rowElements } = elements
  const menus = useMenus({ props, toggle: folds.toggle, rowElements, allSelection, allKey })
  const { editing, rowMenuTarget, openAllNotesMenu, openTrashMenu } = menus
  const trashDrop = drops.noteTarget('trash', props.onTrashNotes, true)
  const selectedBook = selection?.kind === 'book' ? selection.id : undefined
  // A notebook being named shows in a folded Notebooks section too: its name field is there.
  const nameEditing = editing ?? renaming
  const booksShown =
    !folded.has('books') || (nameEditing !== undefined && nameEditing !== ws?.book.id)
  const keys = useRowKeys({ props, folds, menus, rowElements, booksShown, allSelection, allKey })
  const { rowProps, onRowsKey } = keys
  const view: SidebarView = {
    props,
    folds,
    drops,
    menus,
    keys,
    elements,
    selectedBook,
    nameEditing,
  }

  return (
    <nav
      ref={nav}
      className="sidebar"
      data-devot-part="sidebar"
      data-workspace={ws ? '' : undefined}
      aria-label={t('sidebar.label')}
      style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
      onKeyDown={onRowsKey}
    >
      {/* The traffic lights sit here; the bar drags the window. */}
      <div className="titlebar" data-devot-part="sidebar-titlebar" data-tauri-drag-region />
      {ws ? workspaceTitle(view, ws) : null}
      <ul className="sources">
        <li>
          <button
            type="button"
            {...rowProps(allKey)}
            className={`source${rowMenuTarget === allKey ? ' menu-target' : ''}`}
            aria-current={
              (ws ? selectedBook === ws.book.id : selection?.kind === 'all') &&
              props.filter === null
            }
            onClick={() => props.onSelect(allSelection, { clearFilter: true })}
            onMouseDown={keepFocusOnMenu}
            onContextMenu={(e) => {
              e.preventDefault()
              void openAllNotesMenu()
            }}
          >
            <Icon name="notes.all" size="md" />
            <span className="source-label" dir="auto">
              {t('sidebar.allNotes')}
            </span>
            <span className="source-count">{format(props.total)}</span>
          </button>
        </li>
        {ws ? null : (
          <>
            <li>
              {filterRow(
                view,
                { kind: 'pinned' },
                'notes.pinned',
                t('sidebar.pinned'),
                props.pinnedCount,
              )}
            </li>
            <li>
              <button
                type="button"
                {...rowProps('templates')}
                className="source"
                aria-current={selection?.kind === 'templates'}
                onClick={() => props.onSelect({ kind: 'templates' })}
              >
                <Icon name="templates" size="md" />
                <span className="source-label" dir="auto">
                  {t('sidebar.templates')}
                </span>
                <span className="source-count">{format(props.templatesCount)}</span>
              </button>
            </li>
          </>
        )}
      </ul>
      <div ref={scroller} className="sidebar-scroll">
        {sectionHeader(
          view,
          'books',
          'notebooks-heading',
          t('sidebar.notebooks'),
          'books-tree',
          <>
            <button
              type="button"
              className="tool tool-small"
              aria-label={t('sidebar.searchNotebooks')}
              title={t('sidebar.searchNotebooks')}
              onClick={props.onSearchBooks}
            >
              <Icon name="search" size="sm" />
            </button>
            <button
              type="button"
              className="tool tool-small"
              aria-label={t('book.new')}
              title={t('book.new')}
              onClick={() => props.onCreateBook?.(ws?.book.id ?? null)}
              disabled={!props.onCreateBook}
            >
              <Icon name="notebook.new" size="sm" />
            </button>
          </>,
          true,
        )}
        {booksShown ? (
          <ul
            id="books-tree"
            className="books"
            role="tree"
            aria-labelledby="notebooks-heading"
            ref={revealed('section:books')}
          >
            {tree.map((node) => bookNode(view, node))}
          </ul>
        ) : null}
        {sectionHeader(
          view,
          'status',
          'statuses-heading',
          t('sidebar.statuses'),
          'statuses-list',
          null,
        )}
        {folded.has('status') ? null : (
          <ul
            id="statuses-list"
            className="sources"
            aria-labelledby="statuses-heading"
            ref={revealed('section:status')}
          >
            {STATUSES.map((s) => (
              <li key={s.status}>
                {filterRow(
                  view,
                  { kind: 'status', status: s.status },
                  s.icon,
                  t(s.label),
                  props.statusCounts.get(s.status) ?? 0,
                  `status-${s.status}`,
                )}
              </li>
            ))}
          </ul>
        )}
        {savedSearchesSection(view)}
        {tagsSection(view)}
        {agentsSection(view)}
      </div>
      {ws ? null : (
        <ul className="sources trash-source">
          <li>
            <button
              type="button"
              {...rowProps('trash')}
              {...trashDrop.handlers}
              className={`source${trashDrop.className}${rowMenuTarget === 'trash' ? ' menu-target' : ''}`}
              aria-current={selection?.kind === 'trash'}
              onClick={() => props.onSelect({ kind: 'trash' })}
              onMouseDown={keepFocusOnMenu}
              onContextMenu={(e) => {
                e.preventDefault()
                void openTrashMenu()
              }}
            >
              <Icon name="trash" size="md" />
              <span className="source-label" dir="auto">
                {t('sidebar.trash')}
              </span>
              <span className="source-count">{format(props.trashCount)}</span>
            </button>
          </li>
        </ul>
      )}
      <SidebarFooter />
      {sidebarDialogs(view)}
      <div className="sidebar-resize" aria-label={t('sidebar.resize')} {...resizeEdge} />
    </nav>
  )
})
