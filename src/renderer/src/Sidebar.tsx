import { DRAG_BOOK, DRAG_NOTE, DRAG_TEMPLATE, setBookDragData } from './dragData'
import {
  Fragment,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { MAX_BOOK_NAME_CHARS, flattenBookTree, type BookNode } from '../../core/books'
import type { NoteStatus, TagColor, TagRecord } from '../../core/storage'
import { MAX_TAG_NAME_CHARS, type NoteFilter } from '../../core/tags'
import { trimWhitespace } from '../../core/text'
import {
  BOOK_COMMANDS,
  BOOK_MENU,
  WORKSPACE_MENU,
  bookShortcut,
  workspaceShortcut,
  type BookAction,
  type BookMenuTarget,
  type ImportAction,
} from './bookMenu'
import { changesNotes, commandMatches, heldCommandKey } from './commands/registry'
import { useKeymap } from './commands/shortcutSettings'
import { titleWithKey } from './commands/titles'
import { useContextMenu, type MenuPoint } from './contextMenu'
import type { IconName } from './icons/symbols'
import type { MessageKey } from './i18n'
import { currentLocale, format as fill, t } from './i18n'
import { Chevron } from './Chevron'
import { Icon } from './icons/Icon'
import { isImeKey } from './ime'
import { useNameLimit } from './nameLimit'
import { copyText } from './noteMenu'
import {
  ALL_NOTES_MENU,
  FILTER_ROW_MENU,
  TRASH_ROW_MENU,
  type AllNotesAction,
  type FilterRowAction,
  type FilterRowTarget,
  type TrashRowAction,
  type TrashRowTarget,
} from './sourceMenu'
import { TAG_MENU, colorOfAction, tagShortcut, type TagAction, type TagMenuTarget } from './tagMenu'
import { usePaneResize } from './paneResize'
import { SIDEBAR_PANE } from './paneWidth'
import { MoveBookDialog } from './MoveBookDialog'
import { BookIcon } from './BookIcon'
import { NotebookIconDialog } from './NotebookIconDialog'
import { SidebarFooter } from './SidebarFooter'
import { setDragCard } from './listDrag'
import { conceal, reveal, slideIn } from './reveal'
import { useRowMotion } from './rowMotion'
import { currentSectionStore, type CollapsibleSection, type SectionStore } from './sidebarSections'
import { TagDot } from './TagEditor'
import { TagSettingsDialog } from './TagSettingsDialog'

export type Selection =
  | { kind: 'all' }
  | { kind: 'book'; id: string }
  | { kind: 'templates' }
  | { kind: 'trash' }

const draggedNotes = (event: DragEvent) =>
  event.dataTransfer.getData(DRAG_NOTE).split('\n').filter(Boolean)

/**
 * Where a dragged notebook goes on a notebook row: the top quarter puts it
 * before that notebook, the bottom quarter after it, the middle inside it.
 * Notes always go inside.
 */
type DropZone = 'before' | 'inside' | 'after'

interface DropAt {
  id: string | null
  zone: DropZone
  /** Notes are over the row (not a notebook): it fills rather than outlines. */
  notes: boolean
}

function zoneAt(event: DragEvent): DropZone {
  const box = event.currentTarget.getBoundingClientRect()
  const y = event.clientY - box.top
  if (y < box.height / 4) return 'before'
  if (y > (box.height * 3) / 4) return 'after'
  return 'inside'
}

function below(row: Element | null | undefined): MenuPoint | undefined {
  if (!row) return undefined
  const box = row.getBoundingClientRect()
  return { x: box.left, y: box.bottom }
}

/** A notebook open as a workspace: the sidebar shows only it, its notes as All Notes, its sub-notebooks, and the statuses and tags of its notes; no Pinned, Templates or Trash. */
export interface SidebarWorkspace {
  book: BookNode
  parents: readonly BookNode[]
  /** The whole notebook tree (the Move dialog lists every notebook). */
  library: readonly BookNode[]
}

const WORKSPACE_ROW = 'workspace'

type PlacedNode = BookNode & BookMenuTarget

function neighbours(
  tree: BookNode[],
): Map<string, { previousId: string | null; nextId: string | null }> {
  const out = new Map<string, { previousId: string | null; nextId: string | null }>()
  const walk = (nodes: BookNode[]) =>
    nodes.forEach((n, i) => {
      out.set(n.id, {
        previousId: nodes[i - 1]?.id ?? null,
        nextId: nodes[i + 1]?.id ?? null,
      })
      walk(n.children)
    })
  walk(tree)
  return out
}

function subtree(tree: BookNode[], id: string): Set<string> {
  const ids = new Set<string>()
  const add = (n: BookNode) => {
    ids.add(n.id)
    n.children.forEach(add)
  }
  const find = (nodes: BookNode[]): void =>
    nodes.forEach((n) => (n.id === id ? add(n) : find(n.children)))
  find(tree)
  return ids
}

interface Props {
  total: number
  tree: BookNode[]
  counts: ReadonlyMap<string, number>
  selection: Selection | null
  renaming: string | undefined
  /** `clearFilter` also turns the filter off (the arrow keys show the row they arrive at as it is). */
  onSelect: (selection: Selection, options?: { clearFilter?: boolean }) => void
  /** Undefined until the core is ready; the button is disabled until then. */
  onCreateBook: ((parentId: string | null) => void) | undefined
  /** Nothing is renamed, moved, dropped or deleted: the trial is over without a licence. */
  readOnly?: boolean
  onRenameBook: (id: string, name: string) => void
  onRenameDone: () => void
  onMoveBook: (id: string, parentId: string | null) => void
  onPlaceBook: (id: string, targetId: string, where: 'before' | 'after') => void
  onSetAiAccess: (id: string, on: boolean) => void
  onSetBookIcon: (id: string, icon: string | null, color: TagColor | null) => void
  onDeleteBook: (id: string) => void
  onExportBook: (action: 'exportMarkdown' | 'exportHtml', id: string) => void
  onImportBook: (action: ImportAction, id: string) => void
  onMoveNotes: (noteIds: string[], bookId: string) => void
  onTagNotes?: (noteIds: string[], tagId: string) => void
  onSetNotesStatus?: (noteIds: string[], status: NoteStatus) => void
  onTrashNotes?: (noteIds: string[]) => void
  filter: NoteFilter | null
  onFilter: (filter: NoteFilter | null) => void
  pinnedCount: number
  statusCounts: ReadonlyMap<NoteStatus, number>
  tags: readonly TagRecord[]
  tagCounts: ReadonlyMap<string, number>
  onRenameTag: (id: string, name: string) => void
  onSetTagColor: (id: string, color: TagColor | null) => void
  onDeleteTag: (id: string) => void
  templatesCount: number
  trashCount: number
  onSearchBooks: () => void
  /** Filled with the notebook and tag menus, for the note list header's name to open. */
  menus?: Ref<SidebarMenus> | undefined
  onSearchTags: () => void
  onEmptyTrash: () => void
  /** Makes a new note (the All Notes row's menu); absent while the library is not open. */
  onNewNote?: (() => void) | undefined
  /** Where the collapsed sections are kept; this window's local storage by default. */
  sectionStore?: SectionStore
  workspace?: SidebarWorkspace | undefined
  onOpenWorkspace?: (id: string) => void
  onWorkspaceUp?: () => void
}

export interface SidebarMenus {
  book: (id: string, at: MenuPoint) => void
  tag: (id: string, at: MenuPoint) => void
}

export const STATUSES: { status: NoteStatus; icon: IconName; label: MessageKey }[] = [
  { status: 'active', icon: 'status.active', label: 'status.active' },
  { status: 'on_hold', icon: 'status.onHold', label: 'status.on_hold' },
  { status: 'completed', icon: 'status.completed', label: 'status.completed' },
  { status: 'dropped', icon: 'status.dropped', label: 'status.dropped' },
]

const sameFilter = (a: NoteFilter | null, b: NoteFilter) =>
  a !== null &&
  a.kind === b.kind &&
  (a.kind !== 'status' || (b.kind === 'status' && a.status === b.status)) &&
  (a.kind !== 'tag' || (b.kind === 'tag' && a.tagId === b.tagId))

const format = (n: number) => new Intl.NumberFormat(currentLocale()).format(n)

function visibleRows(tree: BookNode[], collapsed: ReadonlySet<string>): BookNode[] {
  const out: BookNode[] = []
  const walk = (nodes: BookNode[]) =>
    nodes.forEach((n) => {
      out.push(n)
      if (!collapsed.has(n.id)) walk(n.children)
    })
  walk(tree)
  return out
}

/** A row the arrow keys move between; its key is `all`, `pinned`, `book:<id>`, `status:<status>`, `tag:<id>`, `templates` or `trash`. */
interface Row {
  key: string
  shows: { selection: Selection } | { filter: NoteFilter }
}

const libraryRow = (selection: Selection): Row => ({
  key: selection.kind === 'book' ? `book:${selection.id}` : selection.kind,
  shows: { selection },
})

const filterRowOf = (filter: NoteFilter): Row => ({
  key:
    filter.kind === 'pinned'
      ? 'pinned'
      : filter.kind === 'status'
        ? `status:${filter.status}`
        : `tag:${filter.tagId}`,
  shows: { filter },
})

function TagGlyph(props: { color: TagColor | null }) {
  return props.color ? (
    <span className="tag-dot-box">
      <TagDot color={props.color} />
    </span>
  ) : (
    <Icon name="tag" size="md" />
  )
}

/** A name edited in place, at most `max` code points. `byKey`: ended with Return or Escape (focus goes back to the row), not by focus moving away; one that ends an input method's composition ends only that. */
function NameField(props: {
  name: string
  max: number
  label?: MessageKey
  onDone: (name: string | null, byKey: boolean) => void
}) {
  const { name, onDone } = props
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const [draft, setDraft] = useState(name)
  const limit = useNameLimit(draft, props.max, setDraft)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const finish = (value: string | null, byKey: boolean) => {
    if (done.current) return
    done.current = true
    onDone(value, byKey)
  }
  return (
    <input
      ref={input}
      className="book-name-field"
      aria-label={t(props.label ?? 'book.nameLabel')}
      value={draft}
      {...limit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (isImeKey(e.nativeEvent)) return
        if (e.key === 'Enter') finish(e.currentTarget.value, true)
        if (e.key === 'Escape') finish(null, true)
      }}
      onBlur={(e) => finish(e.currentTarget.value, false)}
    />
  )
}

/** Renders again only when its props change: its owner keeps them the same while nothing it shows changes (typing in a note renders no sidebar). */
const SIDEBAR_STEP = 'devot:sidebar-step'

export function stepSidebarRow(by: 1 | -1): void {
  window.dispatchEvent(new CustomEvent(SIDEBAR_STEP, { detail: by }))
}

export const Sidebar = memo(function Sidebar(props: Props) {
  useKeymap()
  const { width: sidebarWidth, edge: resizeEdge } = usePaneResize(SIDEBAR_PANE)
  const { tree, counts, selection, renaming } = props
  const ws = props.workspace
  const allSelection: Selection = ws ? { kind: 'book', id: ws.book.id } : { kind: 'all' }
  const allKey = libraryRow(allSelection).key
  const nav = useRef<HTMLElement>(null)
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
      ...props.tags.map((tag) => `tag:${tag.id}`),
    ],
    [tree, props.tags],
  )
  const sidebarElement = () => nav.current
  useRowMotion(sidebarElement, 'data-motion-key', motionKeys, ws?.book.id ?? '', 'slide')
  const sections = useMemo(() => props.sectionStore ?? currentSectionStore(), [props.sectionStore])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => sections.loadBooks())
  const [folded, setFolded] = useState<ReadonlySet<CollapsibleSection>>(() => sections.load())
  // The latest sets: a fold waits for its animation, so two quick folds must each
  // build on the other's result, not on the sets of the render that began them.
  const collapsedNow = useRef(collapsed)
  const foldedNow = useRef(folded)
  const revealNext = useRef(new Set<string>())
  const lists = useRef(new Map<string, HTMLElement>())
  const closing = useRef(new Set<string>())
  const revealed = (key: string) => (el: HTMLElement | null) => {
    if (!el) return void lists.current.delete(key)
    lists.current.set(key, el)
    if (revealNext.current.delete(key)) reveal(el)
  }
  const animated = (key: string, opening: boolean, change: () => void) => {
    if (closing.current.has(key)) {
      if (!opening) return
      // Still open underneath: the close turns back from where it is.
      closing.current.delete(key)
      const el = lists.current.get(key)
      if (el) reveal(el)
      return
    }
    if (opening) return change()
    closing.current.add(key)
    conceal(lists.current.get(key), () => {
      closing.current.delete(key)
      change()
    })
  }
  const toggleSection = (section: CollapsibleSection, open?: boolean) => {
    const key = `section:${section}`
    const opening = open ?? (folded.has(section) || closing.current.has(key))
    animated(key, opening, () => {
      const next = new Set(foldedNow.current)
      if (opening) {
        revealNext.current.add(`section:${section}`)
        next.delete(section)
      } else next.add(section)
      foldedNow.current = next
      setFolded(next)
      sections.save(next)
    })
  }
  const sectionToggles = useRef(new Map<CollapsibleSection, HTMLButtonElement>())
  const [movingBook, setMovingBook] = useState<PlacedNode>()
  const [iconBookId, setIconBookId] = useState<string>()
  const [tagSettings, setTagSettings] = useState<string>()
  const [editing, setEditing] = useState<string>()
  const [dropAt, setDropAt] = useState<DropAt>()
  // The notebook being dragged from this sidebar with its sub-notebooks: where it cannot go.
  const dragging = useRef<ReadonlySet<string> | undefined>(undefined)
  const [draggedBook, setDraggedBook] = useState<string>()
  const [editingTag, setEditingTag] = useState<string>()
  const [menuTarget, setMenuTarget] = useState<string>()

  const [tagMenuTarget, setTagMenuTarget] = useState<string>()
  const [rowMenuTarget, setRowMenuTarget] = useState<string>()
  const [noteDrop, setNoteDrop] = useState<string>()

  const noteTarget = (
    key: string,
    take: ((ids: string[]) => void) | undefined,
    templates: boolean,
  ) => {
    if (!take) return { className: '' }
    const accepts = (event: DragEvent) => {
      const { types } = event.dataTransfer
      return types.includes(DRAG_NOTE) && (templates || !types.includes(DRAG_TEMPLATE))
    }
    const over = (event: DragEvent) => {
      if (!accepts(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setNoteDrop(key)
    }
    return {
      className: noteDrop === key ? ' drop-fill' : '',
      handlers: {
        onDragEnter: over,
        onDragOver: over,
        onDragLeave: (event: DragEvent) => {
          const box = event.currentTarget.getBoundingClientRect()
          const { clientX: x, clientY: y } = event
          if (x > box.left && x < box.right && y > box.top && y < box.bottom) return
          setNoteDrop((at) => (at === key ? undefined : at))
        },
        onDrop: (event: DragEvent) => {
          if (!accepts(event)) return
          event.preventDefault()
          setNoteDrop(undefined)
          const ids = draggedNotes(event)
          if (ids.length > 0) take(ids)
        },
      },
    }
  }

  const filterRow = (
    filter: NoteFilter,
    icon: IconName,
    label: string,
    count: number,
    extra?: string,
    tag?: { color: TagColor | null; onMenu: () => void },
  ) => {
    const key = filterRowOf(filter).key
    const { onTagNotes, onSetNotesStatus } = props
    const drop = noteTarget(
      key,
      filter.kind === 'status' && onSetNotesStatus
        ? (ids) => onSetNotesStatus(ids, filter.status)
        : filter.kind === 'tag' && onTagNotes
          ? (ids) => onTagNotes(ids, filter.tagId)
          : undefined,
      false,
    )
    return (
      <button
        type="button"
        {...rowProps(key)}
        {...drop.handlers}
        className={`source filter${extra ? ` ${extra}` : ''}${drop.className}${rowMenuTarget === key ? ' menu-target' : ''}`}
        aria-pressed={sameFilter(props.filter, filter)}
        onClick={() => props.onFilter(sameFilter(props.filter, filter) ? null : filter)}
        onMouseDown={keepFocusOnMenu}
        onContextMenu={(e) => {
          e.preventDefault()
          if (tag) tag.onMenu()
          else if (filter.kind === 'pinned' || filter.kind === 'status') {
            void openFilterRowMenu(key, filter)
          }
        }}
      >
        {tag ? <TagGlyph color={tag.color} /> : <Icon name={icon} size="md" />}
        <span className="source-label">{label}</span>
        <span className="source-count">{format(count)}</span>
      </button>
    )
  }
  const trashDrop = noteTarget('trash', props.onTrashNotes, true)
  const rows = useRef(new Map<string, HTMLLIElement>())
  const rowList = visibleRows(tree, collapsed)
  const selectedBook = selection?.kind === 'book' ? selection.id : undefined

  // The arrow keys move through every row in the order shown, and the sidebar is one tab stop: the row of the view shown.
  const rowOrder: Row[] = [
    libraryRow(allSelection),
    ...(ws ? [] : [filterRowOf({ kind: 'pinned' }), libraryRow({ kind: 'templates' })]),
    ...rowList.map((n) => libraryRow({ kind: 'book', id: n.id })),
    ...(folded.has('status')
      ? []
      : STATUSES.map((s) => filterRowOf({ kind: 'status', status: s.status }))),
    ...(folded.has('tags')
      ? []
      : props.tags.flatMap((tag) =>
          tag.id === editingTag ? [] : [filterRowOf({ kind: 'tag', tagId: tag.id })],
        )),
    ...(ws ? [] : [libraryRow({ kind: 'trash' })]),
  ]
  const shownKey = props.filter
    ? filterRowOf(props.filter).key
    : libraryRow(selection ?? { kind: 'all' }).key
  const tabStop = rowOrder.some((r) => r.key === shownKey) ? shownKey : allKey
  const rowElements = useRef(new Map<string, HTMLElement>())
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
      : key.startsWith('tag:')
        ? 'tags'
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
  const nameEditing = editing ?? renaming
  const siblings = useMemo(() => neighbours(tree), [tree])
  const placed = (node: BookNode): PlacedNode => ({
    ...node,
    ...(siblings.get(node.id) ?? { previousId: null, nextId: null }),
  })
  const openParent = (node: BookNode) => node.children.length > 0 && !collapsed.has(node.id)

  const toggle = (id: string, open?: boolean) => {
    const key = `book:${id}`
    const shown = !collapsed.has(id) && !closing.current.has(key)
    const opening = open ?? !shown
    if (opening === shown) return
    animated(key, opening, () => {
      if (opening) revealNext.current.add(`book:${id}`)
      const next = new Set(collapsedNow.current)
      if (opening) next.delete(id)
      else next.add(id)
      collapsedNow.current = next
      setCollapsed(next)
      sections.saveBooks(next)
    })
  }

  const focusBook = (id: string) => {
    props.onSelect({ kind: 'book', id })
    rows.current.get(id)?.focus()
  }

  const runAction = (action: BookAction, node: PlacedNode) => {
    if (props.readOnly && action !== 'import' && action !== 'export') {
      if (changesNotes(BOOK_COMMANDS[action])) return
    }
    switch (action) {
      case 'copyId':
        return void copyText(node.id).catch(() => console.warn('W_BOOK_COPY_FAILED', node.id))
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
    const color = colorOfAction(action)
    if (color !== undefined) return props.onSetTagColor(tag.id, color)
    switch (action) {
      case 'rename':
        return setEditingTag(tag.id)
      case 'settings':
        return setTagSettings(tag.id)
      case 'filter':
        return props.onFilter(tag.filtered ? null : { kind: 'tag', tagId: tag.id })
      case 'copyId':
        return void copyText(tag.id).catch(() => console.warn('W_TAG_COPY_FAILED', tag.id))
      case 'delete':
        return props.onDeleteTag(tag.id)
    }
  }
  const showTagMenu = useContextMenu('tag', TAG_MENU, runTagAction)
  const tagTarget = (tag: TagRecord): TagMenuTarget => ({
    id: tag.id,
    color: tag.color,
    filtered: sameFilter(props.filter, { kind: 'tag', tagId: tag.id }),
    inWorkspace: ws !== undefined,
  })
  const openTagMenu = async (tag: TagRecord, at?: MenuPoint) => {
    setTagMenuTarget(tag.id)
    await showTagMenu(tagTarget(tag), at)
    setTagMenuTarget((id) => (id === tag.id ? undefined : id))
  }

  /** A right-click (or Control-click) on a menu row leaves the keyboard where it was. */
  const keepFocusOnMenu = (e: { button: number; ctrlKey: boolean; preventDefault(): void }) => {
    if (e.button === 2 || e.ctrlKey) e.preventDefault()
  }
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

  useImperativeHandle(props.menus, () => ({
    book: (id, at) => {
      if (ws?.book.id === id) return void openWorkspaceMenu(at)
      const node = flattenBookTree(tree).find((n) => n.id === id)
      if (node) void openMenu(node, at)
    },
    tag: (id, at) => {
      const tag = props.tags.find((each) => each.id === id)
      if (tag) void openTagMenu(tag, at)
    },
  }))

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
      runAction(action, placed(node))
    }
  }

  const onDragOver = (event: DragEvent, node: BookNode | null) => {
    const types = event.dataTransfer.types
    const isBook = types.includes(DRAG_BOOK)
    if (!isBook && !(node && types.includes(DRAG_NOTE))) return
    // A notebook never goes on itself or among its own sub-notebooks.
    if (isBook && node && dragging.current?.has(node.id)) {
      setDropAt(undefined)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const next: DropAt = {
      id: node?.id ?? null,
      zone: isBook && node ? zoneAt(event) : 'inside',
      notes: !isBook,
    }
    setDropAt((at) =>
      at?.id === next.id && at.zone === next.zone && at.notes === next.notes ? at : next,
    )
  }

  const onDrop = (event: DragEvent, node: BookNode | null) => {
    event.preventDefault()
    setDropAt(undefined)
    const book = event.dataTransfer.getData(DRAG_BOOK)
    const note = event.dataTransfer.getData(DRAG_NOTE)
    if (book && node === null) {
      const first = tree[0]
      if (first && first.id !== book) props.onPlaceBook(book, first.id, 'before')
      else if (!first && ws && ws.book.id !== book) props.onMoveBook(book, ws.book.id)
    } else if (book && node) {
      if (subtree(tree, book).has(node.id)) return
      const zone = zoneAt(event)
      if (zone === 'inside') props.onMoveBook(book, node.id)
      else props.onPlaceBook(book, node.id, zone)
    } else if (note && node) props.onMoveNotes(draggedNotes(event), node.id)
  }

  /**
   * Leaving a row for one of its own children fires dragleave too; only a
   * pointer outside the row ends the drop there.
   */
  const onDragLeave = (event: DragEvent, id: string | null) => {
    const box = event.currentTarget.getBoundingClientRect()
    const { clientX: x, clientY: y } = event
    if (x > box.left && x < box.right && y > box.top && y < box.bottom) return
    // The row entered next may have set its own drop already.
    setDropAt((at) => (at?.id === id ? undefined : at))
  }

  // A drag that ends anywhere (dropped, or cancelled over a row, where dragleave keeps the drop) ends the drop.
  useEffect(() => {
    const clear = () => {
      setDropAt(undefined)
      setNoteDrop(undefined)
      setDraggedBook(undefined)
    }
    window.addEventListener('dragend', clear, true)
    window.addEventListener('drop', clear, true)
    return () => {
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('drop', clear, true)
    }
  }, [])

  /** After an open notebook the line goes on its item, under its sub-notebooks, where the notebook will go. */
  const dropClasses = (node: BookNode, part: 'item' | 'row') => {
    if (dropAt?.id !== node.id) return ''
    const onItem = dropAt.zone === 'after' && openParent(node)
    if ((part === 'item') !== onItem) return ''
    if (dropAt.zone === 'inside') return dropAt.notes ? ' drop-fill' : ' drop-target'
    if (dropAt.zone === 'before') return ' drop-before'
    return ' drop-after'
  }

  const renderNode = (node: BookNode) => {
    const isOpen = !collapsed.has(node.id)
    const isSelected = node.id === selectedBook
    const editingThis = nameEditing === node.id
    const row = rowProps(libraryRow({ kind: 'book', id: node.id }).key)
    const groupId = `book-children-${node.id}`
    const showChildren = node.children.length > 0 && isOpen
    // The treeitem holds only its own row, so an assistive technology that
    // presses or opens the menu at its centre reaches this notebook, not a
    // sub-notebook. Its sub-notebooks sit beside it and are owned by it.
    return (
      <Fragment key={node.id}>
        <li
          style={{ '--book-depth': node.depth } as CSSProperties}
          data-sidebar-row={row['data-sidebar-row']}
          data-motion-key={`book:${node.id}`}
          ref={(el) => {
            row.ref(el)
            if (el) rows.current.set(node.id, el)
            else rows.current.delete(node.id)
          }}
          role="treeitem"
          aria-level={node.depth + 1}
          aria-selected={isSelected}
          aria-expanded={node.children.length > 0 ? isOpen : undefined}
          aria-owns={showChildren ? groupId : undefined}
          tabIndex={row.tabIndex}
          draggable={!editingThis && !props.readOnly}
          onDragStart={(e) => {
            e.stopPropagation()
            setBookDragData(e.dataTransfer, node)
            dragging.current = subtree(tree, node.id)
            setDraggedBook(node.id)
            setDragCard(e.dataTransfer, [node.name])
          }}
          onDragEnd={(e) => {
            e.stopPropagation()
            dragging.current = undefined
            setDropAt(undefined)
            setDraggedBook(undefined)
          }}
          onKeyDown={(e) => onKey(e, node)}
          onClick={(e) => {
            e.stopPropagation()
            focusBook(node.id)
          }}
        >
          <div
            className={`book-row${dropClasses(node, 'row')}${menuTarget === node.id ? ' menu-target' : ''}`}
            data-dragging={draggedBook === node.id || undefined}
            onDoubleClick={() => props.readOnly || setEditing(node.id)}
            onMouseDown={(e) => {
              // A right-click (or Control-click) leaves the keyboard where it
              // was: the keys keep acting on the selected notebook.
              if (!editingThis && (e.button === 2 || e.ctrlKey)) e.preventDefault()
            }}
            onContextMenu={(e) => {
              // The name field keeps the web view's text menu.
              if (editingThis) return
              e.preventDefault()
              void openMenu(node)
            }}
            onDragEnter={(e) => onDragOver(e, node)}
            onDragOver={(e) => onDragOver(e, node)}
            onDragLeave={(e) => onDragLeave(e, node.id)}
            onDrop={(e) => {
              e.stopPropagation()
              onDrop(e, node)
            }}
          >
            <span
              className="disclosure"
              aria-hidden="true"
              onClick={(e) => {
                e.stopPropagation()
                if (node.children.length > 0) toggle(node.id)
              }}
            >
              {node.children.length > 0 ? <Chevron open={isOpen} closed="right" /> : null}
            </span>
            <BookIcon icon={node.icon} color={node.iconColor} size="md" />
            {editingThis ? (
              <NameField
                name={node.name}
                max={MAX_BOOK_NAME_CHARS}
                onDone={(name, byKey) => {
                  setEditing(undefined)
                  props.onRenameDone()
                  const clean = name === null ? '' : trimWhitespace(name)
                  if (clean && clean !== node.name) {
                    props.onRenameBook(node.id, clean)
                  }
                  // The keyboard goes back to the selected notebook, which is
                  // this one unless it was renamed from its menu; this one when
                  // the selected notebook is hidden in a collapsed parent.
                  if (byKey) {
                    const back = selectedBook ? rows.current.get(selectedBook) : undefined
                    ;(back ?? rows.current.get(node.id))?.focus()
                  }
                }}
              />
            ) : (
              <span className="source-label">{node.name}</span>
            )}
            {node.aiAccess ? (
              <span
                className="book-ai"
                role="img"
                aria-label={t('book.aiAccessOn')}
                title={t('book.aiAccessOn')}
              >
                <Icon name="notebook.ai" size="sm" />
              </span>
            ) : null}
            <span className="source-count">{format(counts.get(node.id) ?? 0)}</span>
          </div>
        </li>
        {showChildren ? (
          <li
            role="none"
            className={dropClasses(node, 'item').trim() || undefined}
            style={{ '--book-depth': node.depth } as CSSProperties}
          >
            <ul id={groupId} role="group" ref={revealed(`book:${node.id}`)}>
              {node.children.map(renderNode)}
            </ul>
          </li>
        ) : null}
      </Fragment>
    )
  }

  const settingsTag = props.tags.find((tag) => tag.id === tagSettings)
  // Closed when the notebook goes (deleted on another device).
  const iconBook =
    iconBookId === undefined
      ? undefined
      : flattenBookTree(ws?.library ?? tree).find((n) => n.id === iconBookId)

  const sectionHeader = (
    section: CollapsibleSection,
    headingId: string,
    label: string,
    listId: string,
    tools: ReactNode,
  ) => {
    const isFolded = folded.has(section)
    return (
      <div className="section-header">
        <span id={headingId}>{label}</span>
        <span className="section-tools">
          {tools}
          <button
            type="button"
            className="tool tool-small"
            ref={(el) => {
              if (el) sectionToggles.current.set(section, el)
              else sectionToggles.current.delete(section)
            }}
            aria-label={fill(t(isFolded ? 'sidebar.expandSection' : 'sidebar.collapseSection'), {
              section: label,
            })}
            aria-expanded={!isFolded}
            aria-controls={isFolded ? undefined : listId}
            onClick={() => toggleSection(section)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' && isFolded) {
                e.preventDefault()
                toggleSection(section, true)
              } else if (e.key === 'ArrowLeft' && !isFolded) {
                e.preventDefault()
                toggleSection(section, false)
              }
            }}
          >
            <Chevron open={!isFolded} closed="up" />
          </button>
        </span>
      </div>
    )
  }

  const workspaceTitle = (space: SidebarWorkspace) => {
    const { book } = space
    const editingThis = nameEditing === book.id
    return (
      <div
        className="sidebar-workspace"
        role="group"
        aria-label={fill(t('sidebar.workspaceLabel'), { name: book.name })}
      >
        <button
          type="button"
          className="tool tool-small sidebar-workspace-back"
          aria-label={t('sidebar.workspaceBack')}
          title={titleWithKey('sidebar.workspaceBack', 'sidebar.workspaceUpFromAnyRow')}
          onClick={props.onWorkspaceUp}
        >
          <span className="chevron" data-turn="left">
            <Icon name="disclosure.open" size="sm" />
          </span>
        </button>
        <div
          {...rowProps(WORKSPACE_ROW)}
          className={`sidebar-workspace-title${rowMenuTarget === WORKSPACE_ROW ? ' menu-target' : ''}`}
          onMouseDown={(e) => {
            if (!editingThis) keepFocusOnMenu(e)
          }}
          onDoubleClick={() => props.readOnly || setEditing(book.id)}
          onContextMenu={(e) => {
            // The name field keeps the web view's text menu.
            if (editingThis) return
            e.preventDefault()
            void openWorkspaceMenu()
          }}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (heldCommandKey(e)) return e.preventDefault()
            if (commandMatches('sidebar.rowMenu', e)) {
              e.preventDefault()
              return void openWorkspaceMenu(below(e.currentTarget))
            }
            const action = workspaceShortcut(e)
            if (!action) return
            e.preventDefault()
            runAction(action, placed(book))
          }}
        >
          <BookIcon icon={book.icon} color={book.iconColor} size="md" />
          <span className="sidebar-workspace-names">
            {space.parents.length > 0 ? (
              <span className="sidebar-workspace-path">
                {space.parents.map((parent) => (
                  <button
                    key={parent.id}
                    type="button"
                    tabIndex={-1}
                    className="sidebar-workspace-parent"
                    aria-label={fill(t('sidebar.workspaceParent'), {
                      name: parent.name,
                    })}
                    title={fill(t('sidebar.workspaceParent'), {
                      name: parent.name,
                    })}
                    onClick={(e) => {
                      e.stopPropagation()
                      props.onOpenWorkspace?.(parent.id)
                    }}
                  >
                    {parent.name}
                  </button>
                ))}
              </span>
            ) : null}
            {editingThis ? (
              <NameField
                name={book.name}
                max={MAX_BOOK_NAME_CHARS}
                onDone={(name, byKey) => {
                  setEditing(undefined)
                  props.onRenameDone()
                  const clean = name === null ? '' : trimWhitespace(name)
                  if (clean && clean !== book.name) props.onRenameBook(book.id, clean)
                  if (byKey) rowElements.current.get(WORKSPACE_ROW)?.focus()
                }}
              />
            ) : (
              <span className="sidebar-workspace-name">{book.name}</span>
            )}
          </span>
        </div>
      </div>
    )
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
      {ws ? workspaceTitle(ws) : null}
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
            <span className="source-label">{t('sidebar.allNotes')}</span>
            <span className="source-count">{format(props.total)}</span>
          </button>
        </li>
        {ws ? null : (
          <>
            <li>
              {filterRow(
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
                <span className="source-label">{t('sidebar.templates')}</span>
                <span className="source-count">{format(props.templatesCount)}</span>
              </button>
            </li>
          </>
        )}
      </ul>
      <div className="sidebar-scroll">
        <div
          className={`section-header${dropAt && dropAt.id === null ? ' drop-target' : ''}`}
          onDragEnter={(e) => onDragOver(e, null)}
          onDragOver={(e) => onDragOver(e, null)}
          onDragLeave={(e) => onDragLeave(e, null)}
          onDrop={(e) => onDrop(e, null)}
        >
          <span id="notebooks-heading">{t('sidebar.notebooks')}</span>
          <span className="section-tools">
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
          </span>
        </div>
        <ul className="books" role="tree" aria-labelledby="notebooks-heading">
          {tree.map(renderNode)}
        </ul>
        {sectionHeader('status', 'statuses-heading', t('sidebar.statuses'), 'statuses-list', null)}
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
        {props.tags.length > 0 ? (
          <>
            {sectionHeader(
              'tags',
              'tags-heading',
              t('sidebar.tags'),
              'tags-list',
              <button
                type="button"
                className="tool tool-small"
                aria-label={t('sidebar.searchTags')}
                title={t('sidebar.searchTags')}
                onClick={props.onSearchTags}
              >
                <Icon name="search" size="sm" />
              </button>,
            )}
            {folded.has('tags') ? null : (
              <ul
                id="tags-list"
                className="sources tags"
                aria-labelledby="tags-heading"
                ref={revealed('section:tags')}
              >
                {props.tags.map((tag) => (
                  <li
                    key={tag.id}
                    data-motion-key={`tag:${tag.id}`}
                    onDoubleClick={() => props.readOnly || setEditingTag(tag.id)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget.firstElementChild) return
                      if (heldCommandKey(e)) return e.preventDefault()
                      if (commandMatches('sidebar.rowMenu', e)) {
                        e.preventDefault()
                        return void openTagMenu(tag, below(e.target as Element))
                      }
                      const action = tagShortcut(e)
                      // A workspace deletes no tag (Backspace there does nothing).
                      if (!action || (action === 'delete' && ws)) return
                      e.preventDefault()
                      runTagAction(action, tagTarget(tag))
                    }}
                  >
                    {editingTag === tag.id ? (
                      <div className="source tag-row">
                        <TagGlyph color={tag.color} />
                        <NameField
                          name={tag.name}
                          max={MAX_TAG_NAME_CHARS}
                          label="tag.nameLabel"
                          onDone={(name) => {
                            setEditingTag(undefined)
                            const clean = name === null ? '' : trimWhitespace(name)
                            if (clean && clean !== tag.name) {
                              props.onRenameTag(tag.id, clean)
                            }
                          }}
                        />
                      </div>
                    ) : (
                      filterRow(
                        { kind: 'tag', tagId: tag.id },
                        'tag',
                        tag.name,
                        props.tagCounts.get(tag.id) ?? 0,
                        `tag-row${tagMenuTarget === tag.id ? ' menu-target' : ''}`,
                        {
                          color: tag.color,
                          onMenu: () => void openTagMenu(tag),
                        },
                      )
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
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
              <span className="source-label">{t('sidebar.trash')}</span>
              <span className="source-count">{format(props.trashCount)}</span>
            </button>
          </li>
        </ul>
      )}
      <SidebarFooter />
      {movingBook ? (
        <MoveBookDialog
          tree={ws?.library ?? tree}
          book={movingBook}
          onMove={(parentId) => {
            props.onMoveBook(movingBook.id, parentId)
            setMovingBook(undefined)
          }}
          onCancel={() => setMovingBook(undefined)}
        />
      ) : null}
      {iconBook ? (
        <NotebookIconDialog
          book={iconBook}
          onPick={(icon, color) => {
            if (icon !== iconBook.icon || color !== iconBook.iconColor)
              props.onSetBookIcon(iconBook.id, icon, color)
            setIconBookId(undefined)
          }}
          onRevert={() => {
            props.onSetBookIcon(iconBook.id, null, null)
            setIconBookId(undefined)
          }}
          onCancel={() => setIconBookId(undefined)}
        />
      ) : null}
      {settingsTag ? (
        <TagSettingsDialog
          tag={settingsTag}
          onSave={({ name, color }) => {
            if (name !== settingsTag.name) props.onRenameTag(settingsTag.id, name)
            if (color !== settingsTag.color) props.onSetTagColor(settingsTag.id, color)
            setTagSettings(undefined)
          }}
          onCancel={() => setTagSettings(undefined)}
        />
      ) : null}
      <div className="sidebar-resize" aria-label={t('sidebar.resize')} {...resizeEdge} />
    </nav>
  )
})
