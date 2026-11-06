import { useEffect, type KeyboardEvent, type RefObject } from 'react'
import type { BookNode } from '../../../core/books'
import type { NoteStatus } from '../../../core/storage'
import { bookActionShown, bookShortcut } from '../bookMenu'
import { commandMatches, heldCommandKey } from '../commands/registry'
import type { CollapsibleSection } from '../sidebarSections'
import {
  agentFilter,
  below,
  filterRowOf,
  libraryRow,
  sameFilter,
  searchRow,
  STATUSES,
  visibleRows,
  WORKSPACE_ROW,
  type Row,
  type Selection,
  type SidebarProps,
} from './model'
import type { Folds } from './useFolds'
import type { FilterRowTarget } from '../sourceMenu'
import type { Menus } from './useMenus'

const SIDEBAR_STEP = 'devot:sidebar-step'

export function stepSidebarRow(by: 1 | -1): void {
  window.dispatchEvent(new CustomEvent(SIDEBAR_STEP, { detail: by }))
}

/** The rows the arrow keys move between, the one tab stop among them, and the keys of each row. */
export function useRowKeys({
  props,
  folds,
  menus,
  rowElements,
  booksShown,
  allSelection,
  allKey,
}: {
  props: SidebarProps
  folds: Folds
  menus: Menus
  rowElements: RefObject<Map<string, HTMLElement>>
  booksShown: boolean
  allSelection: Selection
  allKey: string
}) {
  const { tree, selection } = props
  const ws = props.workspace
  const savedSearches = props.savedSearches ?? []
  const { collapsed, folded, toggle, toggleSection, sectionToggles } = folds
  const {
    editingSearch,
    editingTag,
    placed,
    runAction,
    openMenu,
    openFilterRowMenu,
    openTrashMenu,
    openAllNotesMenu,
  } = menus
  const rowList = visibleRows(tree, collapsed)

  // The arrow keys move through every row in the order shown, and the sidebar is one tab stop: the row of the view shown.
  const rowOrder: Row[] = [
    libraryRow(allSelection),
    ...(ws ? [] : [filterRowOf({ kind: 'pinned' }), libraryRow({ kind: 'templates' })]),
    ...(booksShown ? rowList.map((n) => libraryRow({ kind: 'book', id: n.id })) : []),
    ...(folded.has('status')
      ? []
      : STATUSES.map((s) => filterRowOf({ kind: 'status', status: s.status }))),
    ...(folded.has('searches')
      ? []
      : savedSearches.flatMap((s) => (s.id === editingSearch ? [] : [searchRow(s.id)]))),
    ...(folded.has('tags')
      ? []
      : props.tags.flatMap((tag) =>
          tag.id === editingTag ? [] : [filterRowOf({ kind: 'tag', tagId: tag.id })],
        )),
    ...(folded.has('agents') ? [] : (props.agents ?? []).map((a) => filterRowOf(agentFilter(a)))),
    ...(ws ? [] : [libraryRow({ kind: 'trash' })]),
  ]
  const shownKey = props.activeSearch
    ? searchRow(props.activeSearch).key
    : props.filter
      ? filterRowOf(props.filter).key
      : libraryRow(selection ?? { kind: 'all' }).key
  const tabStop = rowOrder.some((r) => r.key === shownKey) ? shownKey : allKey
  const rowProps = (key: string) => ({
    'data-sidebar-row': key,
    tabIndex: key === tabStop ? 0 : -1,
    ref: (el: HTMLElement | null) => {
      if (el) rowElements.current.set(key, el)
      else rowElements.current.delete(key)
    },
  })

  /** All Notes or a notebook shows without a filter, the Trash shows (a filter does not apply there), and a filter row turns its filter on. */
  const arrive = (row: Row, focusRow = true) => {
    if (focusRow) rowElements.current.get(row.key)?.focus()
    if ('search' in row.shows) return props.onRunSavedSearch?.(row.shows.search)
    if ('selection' in row.shows) {
      const { selection: next } = row.shows
      return props.onSelect(next, { clearFilter: next.kind !== 'trash' })
    }
    if (!sameFilter(props.filter, row.shows.filter)) props.onFilter(row.shows.filter)
  }

  const onRowsKey = (event: KeyboardEvent) => {
    const key = event.target instanceof HTMLElement ? event.target.dataset['sidebarRow'] : undefined
    const fixed =
      key === allKey ||
      key === WORKSPACE_ROW ||
      key === 'pinned' ||
      key === 'templates' ||
      key === 'trash' ||
      key?.startsWith('status:') === true
    if (
      key !== undefined &&
      ws &&
      !event.defaultPrevented &&
      (commandMatches('sidebar.workspaceUpFromAnyRow', event) ||
        (fixed && commandMatches('sidebar.workspaceUp', event)))
    ) {
      event.preventDefault()
      return props.onWorkspaceUp?.()
    }
    if (
      key !== undefined &&
      !event.defaultPrevented &&
      (key === allKey || key === 'pinned' || key === 'trash' || key.startsWith('status:')) &&
      commandMatches('sidebar.rowMenu', event)
    ) {
      event.preventDefault()
      const at = below(event.target as Element)
      if (key === allKey) return void openAllNotesMenu(at)
      if (key === 'trash') return void openTrashMenu(at)
      const filter: FilterRowTarget['filter'] =
        key === 'pinned'
          ? { kind: 'pinned' }
          : { kind: 'status', status: key.slice('status:'.length) as NoteStatus }
      return void openFilterRowMenu(key, filter, at)
    }
    if (key === undefined || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
      return
    const section: CollapsibleSection | undefined = key.startsWith('status:')
      ? 'status'
      : key.startsWith('search:')
        ? 'searches'
        : key.startsWith('tag:')
          ? 'tags'
          : key.startsWith('agent:')
            ? 'agents'
            : undefined
    if (section && event.key === 'ArrowLeft') {
      event.preventDefault()
      toggleSection(section, false)
      sectionToggles.current.get(section)?.focus()
      return
    }
    const at = rowOrder.findIndex((r) => r.key === key)
    const moves: Record<string, Row | undefined> = {
      ArrowDown: rowOrder[at + 1],
      ArrowUp: rowOrder[at - 1],
      Home: rowOrder[0],
      End: rowOrder[rowOrder.length - 1],
    }
    if (!Object.hasOwn(moves, event.key)) return
    event.preventDefault()
    if (ws && at === 0 && event.key === 'ArrowUp') {
      return rowElements.current.get(WORKSPACE_ROW)?.focus()
    }
    const to = moves[event.key]
    if (to !== undefined && to.key !== key) arrive(to)
  }
  useEffect(() => {
    const onStep = (e: Event) => {
      const by = (e as CustomEvent<unknown>).detail
      if (by !== 1 && by !== -1) return
      const to = rowOrder[rowOrder.findIndex((r) => r.key === shownKey) + by]
      if (to !== undefined) arrive(to, false)
    }
    window.addEventListener(SIDEBAR_STEP, onStep)
    return () => window.removeEventListener(SIDEBAR_STEP, onStep)
  })

  const onKey = (event: KeyboardEvent, node: BookNode) => {
    if (event.target !== event.currentTarget) return
    if (heldCommandKey(event)) return event.preventDefault()
    const open = node.children.length > 0 && !collapsed.has(node.id)
    const go = (target: BookNode | undefined) => {
      if (!target) return
      event.preventDefault()
      arrive(libraryRow({ kind: 'book', id: target.id }))
    }
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault()
        if (node.children.length > 0 && !open) toggle(node.id, true)
        else if (open) go(node.children[0])
        return
      case 'ArrowLeft':
        event.preventDefault()
        if (open) toggle(node.id, false)
        else if (ws && node.parentId === ws.book.id) arrive(libraryRow(allSelection))
        else if (node.parentId) go(rowList.find((n) => n.id === node.parentId))
        return
    }
    if (commandMatches('sidebar.rowMenu', event)) {
      event.preventDefault()
      const at = below(event.currentTarget.querySelector(':scope > .book-row'))
      return void openMenu(node, at)
    }
    const action = bookShortcut(event)
    if (action) {
      event.preventDefault()
      const target = placed(node)
      if (bookActionShown(action, target)) runAction(action, target)
    }
  }

  return { rowProps, arrive, onRowsKey, onKey }
}

export type RowKeys = ReturnType<typeof useRowKeys>
