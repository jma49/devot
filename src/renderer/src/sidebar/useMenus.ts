import { useImperativeHandle, useMemo, useState, type RefObject } from 'react'
import { flattenBookTree, type BookNode } from '../../../core/books'
import { errorCode } from '../../../core/errors'
import type { TagRecord } from '../../../core/storage'
import { BOOK_COMMANDS, BOOK_MENU, WORKSPACE_MENU, type BookAction } from '../bookMenu'
import { changesNotes } from '../commands/registry'
import { useContextMenu, type MenuPoint } from '../contextMenu'
import { copyText } from '../noteMenu'
import {
  SAVED_SEARCH_MENU,
  type SavedSearchAction,
  type SavedSearchMenuTarget,
} from '../savedSearchMenu'
import {
  ALL_NOTES_MENU,
  FILTER_ROW_MENU,
  TRASH_ROW_MENU,
  type AllNotesAction,
  type FilterRowAction,
  type FilterRowTarget,
  type TrashRowAction,
  type TrashRowTarget,
} from '../sourceMenu'
import type { TagAction, TagMenuTarget } from '../tagMenu'
import {
  below,
  neighbours,
  sameFilter,
  searchRow,
  WORKSPACE_ROW,
  type PlacedNode,
  type Selection,
  type SidebarProps,
} from './model'

/** A right-click (or Control-click) on a menu row leaves the keyboard where it was. */
export const keepFocusOnMenu = (e: {
  button: number
  ctrlKey: boolean
  preventDefault(): void
}) => {
  if (e.button === 2 || e.ctrlKey) e.preventDefault()
}

/** The sidebar's menus and what they start: renaming in place, the Move, icon and tag settings dialogs, and the rest of their actions. */
export function useMenus({
  props,
  toggle,
  rowElements,
  allSelection,
  allKey,
}: {
  props: SidebarProps
  toggle: (id: string, open?: boolean) => void
  rowElements: RefObject<Map<string, HTMLElement>>
  allSelection: Selection
  allKey: string
}) {
  const { tree } = props
  const ws = props.workspace
  const [movingBook, setMovingBook] = useState<PlacedNode>()
  const [iconBookId, setIconBookId] = useState<string>()
  const [tagSettings, setTagSettings] = useState<string>()
  const [editing, setEditing] = useState<string>()
  const [editingTag, setEditingTag] = useState<string>()
  const [editingSearch, setEditingSearch] = useState<string>()
  const [menuTarget, setMenuTarget] = useState<string>()
  const [tagMenu, setTagMenu] = useState<{ id: string; at: MenuPoint }>()
  const [rowMenuTarget, setRowMenuTarget] = useState<string>()

  const siblings = useMemo(() => neighbours(tree), [tree])
  const placed = (node: BookNode): PlacedNode => ({
    ...node,
    ...(siblings.get(node.id) ?? { previousId: null, nextId: null }),
  })

  const runAction = (action: BookAction, node: PlacedNode) => {
    if (props.readOnly && action !== 'import' && action !== 'export') {
      if (changesNotes(BOOK_COMMANDS[action])) return
    }
    switch (action) {
      case 'copyId':
        return void copyText(node.id).catch((e: unknown) => {
          const code = errorCode(e)
          console.warn('W_BOOK_COPY_FAILED', node.id, code)
          props.onCopyFailed?.('copyId', code)
        })
      case 'move':
        return setMovingBook(node)
      case 'newInside':
        // Open it, so the new notebook shows inside.
        toggle(node.id, true)
        return props.onCreateBook?.(node.id)
      case 'openWorkspace':
        return props.onOpenWorkspace?.(node.id)
      case 'rename':
        return setEditing(node.id)
      case 'changeIcon':
        return setIconBookId(node.id)
      case 'moveUp':
        return node.previousId && props.onPlaceBook(node.id, node.previousId, 'before')
      case 'moveDown':
        return node.nextId && props.onPlaceBook(node.id, node.nextId, 'after')
      case 'moveToTop':
        return props.onMoveBook(node.id, null)
      case 'aiAccess':
        return props.onSetAiAccess(node.id, !node.aiAccess)
      case 'importMarkdownFiles':
      case 'importMarkdownFolder':
      case 'importHtmlFiles':
        return props.onImportBook(action, node.id)
      case 'exportMarkdown':
      case 'exportHtml':
        return props.onExportBook(action, node.id)
      case 'import':
      case 'export':
        // They only name the submenus.
        return
      case 'delete':
        return props.onDeleteBook(node.id)
    }
  }
  const showMenu = useContextMenu('book', BOOK_MENU, runAction)
  const openMenu = async (node: BookNode, at?: MenuPoint) => {
    setMenuTarget(node.id)
    await showMenu(placed(node), at)
    setMenuTarget((id) => (id === node.id ? undefined : id))
  }

  const runTagAction = (action: TagAction, tag: TagMenuTarget) => {
    if (props.readOnly && !(action === 'filter' || action === 'copyId')) return
    switch (action) {
      case 'rename':
        return setEditingTag(tag.id)
      case 'settings':
        return setTagSettings(tag.id)
      case 'filter':
        return props.onFilter(tag.filtered ? null : { kind: 'tag', tagId: tag.id })
      case 'copyId':
        return void copyText(tag.id).catch((e: unknown) => {
          const code = errorCode(e)
          console.warn('W_TAG_COPY_FAILED', tag.id, code)
          props.onCopyFailed?.('copyId', code)
        })
      case 'delete':
        return props.onDeleteTag(tag.id)
    }
  }
  const tagTarget = (tag: TagRecord): TagMenuTarget => ({
    id: tag.id,
    color: tag.color,
    filtered: sameFilter(props.filter, { kind: 'tag', tagId: tag.id }),
    inWorkspace: ws !== undefined,
  })
  const openTagMenu = (tag: TagRecord, at?: MenuPoint) => {
    const row = document.querySelector(`[data-motion-key="tag:${tag.id}"]`)
    const place = at ?? below(row) ?? { x: 0, y: 0 }
    setTagMenu({ id: tag.id, at: place })
  }
  const shownTagMenu = props.tags.find((tag) => tag.id === tagMenu?.id)

  const withRowOutline = async (key: string, show: () => Promise<void>) => {
    setRowMenuTarget(key)
    await show()
    setRowMenuTarget((open) => (open === key ? undefined : open))
  }
  const showTrashMenu = useContextMenu<TrashRowAction, TrashRowTarget>(
    'trashRow',
    TRASH_ROW_MENU,
    () => props.onEmptyTrash(),
  )
  const showAllNotesMenu = useContextMenu('allNotes', ALL_NOTES_MENU, (action: AllNotesAction) => {
    if (action === 'newNote') props.onNewNote?.()
    else props.onSelect(allSelection, { clearFilter: true })
  })
  const showFilterMenu = useContextMenu(
    'filterRow',
    FILTER_ROW_MENU,
    (_: FilterRowAction, row: FilterRowTarget) => props.onFilter(row.filtered ? null : row.filter),
  )
  const openFilterRowMenu = (key: string, filter: FilterRowTarget['filter'], at?: MenuPoint) =>
    withRowOutline(key, () =>
      showFilterMenu({ filter, filtered: sameFilter(props.filter, filter) }, at),
    )
  const openTrashMenu = async (at?: MenuPoint) => {
    if (props.trashCount === 0) return
    await withRowOutline('trash', () => showTrashMenu({ notes: props.trashCount }, at))
  }
  const showWorkspaceMenu = useContextMenu('workspace', WORKSPACE_MENU, runAction)
  const openWorkspaceMenu = (at?: MenuPoint) =>
    ws ? withRowOutline(WORKSPACE_ROW, () => showWorkspaceMenu(placed(ws.book), at)) : undefined
  const openAllNotesMenu = (at?: MenuPoint) =>
    withRowOutline(allKey, () => showAllNotesMenu({ canCreate: props.onNewNote !== undefined }, at))

  const runSearchAction = (action: SavedSearchAction, target: SavedSearchMenuTarget) => {
    if (props.readOnly) return
    if (action === 'rename') setEditingSearch(target.id)
    else if (action === 'edit') props.onEditSavedSearch?.(target.id)
    else props.onDeleteSavedSearch?.(target.id)
  }
  const showSearchMenu = useContextMenu('savedSearchRow', SAVED_SEARCH_MENU, runSearchAction)
  const openSearchMenu = (id: string, at?: MenuPoint) => {
    if (props.readOnly) return
    const key = searchRow(id).key
    return withRowOutline(key, () =>
      showSearchMenu({ id }, at ?? below(rowElements.current.get(key))),
    )
  }

  useImperativeHandle(props.menus, () => ({
    book: (id, at) => {
      if (ws?.book.id === id) return void openWorkspaceMenu(at)
      const node = flattenBookTree(tree).find((n) => n.id === id)
      if (node) void openMenu(node, at)
    },
    tag: (id, at) => {
      const tag = props.tags.find((each) => each.id === id)
      if (tag) openTagMenu(tag, at)
    },
  }))

  return {
    movingBook,
    setMovingBook,
    iconBookId,
    setIconBookId,
    tagSettings,
    setTagSettings,
    editing,
    setEditing,
    editingTag,
    setEditingTag,
    editingSearch,
    setEditingSearch,
    menuTarget,
    tagMenu,
    setTagMenu,
    rowMenuTarget,
    placed,
    runAction,
    openMenu,
    runTagAction,
    tagTarget,
    openTagMenu,
    shownTagMenu,
    openFilterRowMenu,
    openTrashMenu,
    openWorkspaceMenu,
    openAllNotesMenu,
    runSearchAction,
    openSearchMenu,
  }
}

export type Menus = ReturnType<typeof useMenus>
