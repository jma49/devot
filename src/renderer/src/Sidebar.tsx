import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
} from 'react'
import { MAX_BOOK_NAME_CHARS, type BookNode } from '../../core/books'
import type { NoteStatus, TagColor, TagRecord } from '../../core/storage'
import { MAX_TAG_NAME_CHARS, type NoteFilter } from '../../core/tags'
import { trimWhitespace } from '../../core/text'
import { BOOK_MENU, bookShortcut, type BookAction, type BookMenuTarget } from './bookMenu'
import { commandMatches, heldCommandKey } from './commands/registry'
import { useKeymap } from './commands/shortcutSettings'
import { titleWithKey } from './commands/titles'
import { useContextMenu, type MenuPoint } from './contextMenu'
import type { IconName } from './icons/symbols'
import type { MessageKey } from './i18n'
import { currentLocale, t } from './i18n'
import { Icon } from './icons/Icon'
import { isImeKey } from './ime'
import { useNameLimit } from './nameLimit'
import { copyText } from './noteMenu'
import { TAG_MENU, colorOfAction, tagShortcut, type TagAction, type TagMenuTarget } from './tagMenu'
import { TagDot } from './TagEditor'

export type Selection =
  | { kind: 'all' }
  | { kind: 'book'; id: string }
  | { kind: 'templates' }
  | { kind: 'trash' }

/**
 * Drag payloads: note rows (their IDs, one per line) or a notebook row. A
 * drag of templates also carries DRAG_TEMPLATE: a status or tag row does not
 * take templates (their own status and tags are not used).
 */
export const DRAG_NOTE = 'application/x-devot-note'
export const DRAG_TEMPLATE = 'application/x-devot-template'
const DRAG_BOOK = 'application/x-devot-book'

/** The note IDs a drag carries. */
const draggedNotes = (event: DragEvent) =>
  event.dataTransfer.getData(DRAG_NOTE).split('\n').filter(Boolean)

/**
 * Where a dragged notebook goes on a notebook row: the top quarter puts it
 * before that notebook, the bottom quarter after it, the middle inside it.
 * Notes always go inside.
 */
type DropZone = 'before' | 'inside' | 'after'

/** A drop on a notebook row (`id`) or on the Notebooks header (`id` null). */
interface DropAt {
  id: string | null
  zone: DropZone
}

function zoneAt(event: DragEvent): DropZone {
  const box = event.currentTarget.getBoundingClientRect()
  const y = event.clientY - box.top
  if (y < box.height / 4) return 'before'
  if (y > (box.height * 3) / 4) return 'after'
  return 'inside'
}

/** Where a row's menu opens from the keyboard: under the row, at its left edge. */
function below(row: Element | null | undefined): MenuPoint | undefined {
  if (!row) return undefined
  const box = row.getBoundingClientRect()
  return { x: box.left, y: box.bottom }
}

/** A notebook with the siblings shown just above and below it. */
type PlacedNode = BookNode & BookMenuTarget

/** Each notebook's previous and next sibling, in the tree's order. */
function neighbours(
  tree: BookNode[],
): Map<string, { previousId: string | null; nextId: string | null }> {
  const out = new Map<string, { previousId: string | null; nextId: string | null }>()
  const walk = (nodes: BookNode[]) =>
    nodes.forEach((n, i) => {
      out.set(n.id, { previousId: nodes[i - 1]?.id ?? null, nextId: nodes[i + 1]?.id ?? null })
      walk(n.children)
    })
  walk(tree)
  return out
}

/** The IDs of a notebook and every notebook below it. */
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
  /**
   * What shows as selected: All Notes, a notebook or the Trash; null for
   * nothing (while a search covers every note).
   */
  selection: Selection | null
  /** A notebook to show in rename mode (just created). */
  renaming: string | undefined
  /**
   * Shows All Notes, a notebook or the Trash; `clearFilter` also turns the
   * filter off (the arrow keys show the row they arrive at as it is).
   */
  onSelect: (selection: Selection, options?: { clearFilter?: boolean }) => void
  /**
   * Creates a notebook (inside `parentId`, or at the top level) to name.
   * Undefined until the core is ready; the button is disabled until then.
   */
  onCreateBook: ((parentId: string | null) => void) | undefined
  onRenameBook: (id: string, name: string) => void
  onRenameDone: () => void
  onMoveBook: (id: string, parentId: string | null) => void
  /** Puts a notebook right before or after another one, beside it in the tree. */
  onPlaceBook: (id: string, targetId: string, where: 'before' | 'after') => void
  /** Turns Allow AI Access on or off for one notebook. */
  onSetAiAccess: (id: string, on: boolean) => void
  onDeleteBook: (id: string) => void
  /** Exports a notebook with its sub-notebooks (exporter.ts). */
  onExportBook: (action: 'exportMarkdown' | 'exportHtml', id: string) => void
  /** Notes dropped on a notebook row: they move there. */
  onMoveNotes: (noteIds: string[], bookId: string) => void
  /** Notes dropped on a tag row: they get that tag. */
  onTagNotes?: (noteIds: string[], tagId: string) => void
  /** Notes dropped on a status row: they get that status. */
  onSetNotesStatus?: (noteIds: string[], status: NoteStatus) => void
  /** Notes dropped on the Trash: they move to the Trash. */
  onTrashNotes?: (noteIds: string[]) => void
  /** The status, tag or pinned filter; combines with the notebook. */
  filter: NoteFilter | null
  onFilter: (filter: NoteFilter | null) => void
  pinnedCount: number
  statusCounts: ReadonlyMap<NoteStatus, number>
  tags: readonly TagRecord[]
  tagCounts: ReadonlyMap<string, number>
  onRenameTag: (id: string, name: string) => void
  /** Sets a tag's colour, or takes it off (null). */
  onSetTagColor: (id: string, color: TagColor | null) => void
  onDeleteTag: (id: string) => void
  /** Templates (notes in the Templates notebook), apart from the library. */
  templatesCount: number
  trashCount: number
  /** Hides the sidebar (its title bar's button). */
  onHide: () => void
}

const STATUSES: { status: NoteStatus; icon: IconName; label: MessageKey }[] = [
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

/** The rows a keyboard user can reach, in order. */
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

/**
 * A row the arrow keys move between (`all`, `pinned`, `book:<id>`,
 * `status:<status>`, `tag:<id>`, `templates`, `trash`), and what it shows.
 */
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

/** A tag row's lead: its colour as a dot, or the tag icon when it has none. */
function TagGlyph(props: { color: TagColor | null }) {
  return props.color ? (
    <span className="tag-dot-box">
      <TagDot color={props.color} />
    </span>
  ) : (
    <Icon name="tag" size="md" />
  )
}

/**
 * A name edited in place, at most `max` code points. `byKey`: ended with
 * Return or Escape (focus goes back to the row), not by focus moving away.
 * The Return or Escape that ends an input method's composition ends only
 * that.
 */
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

/**
 * The left pane over the window material (or on an opaque surface when
 * Settings > Appearance turned the material off): All Notes and the
 * notebook tree. It renders again only when its props change: its owner
 * keeps them the same while nothing it shows changes (typing in a note
 * renders no sidebar).
 */
/** The page event that moves the sidebar's view to the next (1) or previous (-1) row. */
const SIDEBAR_STEP = 'devot:sidebar-step'

/** Shows the row after (1) or before (-1) the one shown (Next and Previous Sidebar Row). */
export function stepSidebarRow(by: 1 | -1): void {
  window.dispatchEvent(new CustomEvent(SIDEBAR_STEP, { detail: by }))
}

export const Sidebar = memo(function Sidebar(props: Props) {
  useKeymap()
  const { tree, counts, selection, renaming } = props
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<string>()
  const [dropAt, setDropAt] = useState<DropAt>()
  // The notebook being dragged from this sidebar with its sub-notebooks: where it cannot go.
  const dragging = useRef<ReadonlySet<string> | undefined>(undefined)
  const [editingTag, setEditingTag] = useState<string>()
  // The notebook whose context menu is open: outlined, not selected.
  const [menuTarget, setMenuTarget] = useState<string>()

  // The tag whose context menu is open: outlined.
  const [tagMenuTarget, setTagMenuTarget] = useState<string>()
  // The status, tag or Trash row notes are dragged over (its row key).
  const [noteDrop, setNoteDrop] = useState<string>()

  /**
   * Drop handling for a row that takes dragged notes (a status, a tag, the
   * Trash; `templates`: templates too). It shows as a drop target while
   * notes are over it.
   */
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
      className: noteDrop === key ? ' drop-target' : '',
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

  /**
   * A filter row: pressing it toggles the filter. A tag row shows its colour
   * (if any) in place of the icon and has a context menu.
   */
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
        className={`source filter${extra ? ` ${extra}` : ''}${drop.className}`}
        aria-pressed={sameFilter(props.filter, filter)}
        onClick={() => props.onFilter(sameFilter(props.filter, filter) ? null : filter)}
        onMouseDown={
          tag
            ? (e) => {
                // A right-click (or Control-click) leaves the keyboard where it was.
                if (e.button === 2 || e.ctrlKey) e.preventDefault()
              }
            : undefined
        }
        onContextMenu={
          tag
            ? (e) => {
                e.preventDefault()
                tag.onMenu()
              }
            : undefined
        }
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

  // The arrow keys move through every row in the order shown (a tag being
  // renamed has no row then), and the sidebar is one tab stop: the row of
  // the view shown (its filter, else its notebook, Templates, the Trash or All Notes).
  const rowOrder: Row[] = [
    libraryRow({ kind: 'all' }),
    filterRowOf({ kind: 'pinned' }),
    ...rowList.map((n) => libraryRow({ kind: 'book', id: n.id })),
    ...STATUSES.map((s) => filterRowOf({ kind: 'status', status: s.status })),
    ...props.tags.flatMap((tag) =>
      tag.id === editingTag ? [] : [filterRowOf({ kind: 'tag', tagId: tag.id })],
    ),
    libraryRow({ kind: 'templates' }),
    libraryRow({ kind: 'trash' }),
  ]
  const shownKey = props.filter
    ? filterRowOf(props.filter).key
    : libraryRow(selection ?? { kind: 'all' }).key
  const tabStop = rowOrder.some((r) => r.key === shownKey) ? shownKey : 'all'
  const rowElements = useRef(new Map<string, HTMLElement>())
  const rowProps = (key: string) => ({
    'data-sidebar-row': key,
    tabIndex: key === tabStop ? 0 : -1,
    ref: (el: HTMLElement | null) => {
      if (el) rowElements.current.set(key, el)
      else rowElements.current.delete(key)
    },
  })

  /**
   * Moves the keyboard to a row, and the view follows: All Notes or a
   * notebook shows without a filter, the Trash shows (a filter does not
   * apply there), and a filter row turns its filter on.
   */
  const arrive = (row: Row, focusRow = true) => {
    if (focusRow) rowElements.current.get(row.key)?.focus()
    if ('selection' in row.shows) {
      const { selection: next } = row.shows
      return props.onSelect(next, { clearFilter: next.kind !== 'trash' })
    }
    if (!sameFilter(props.filter, row.shows.filter)) props.onFilter(row.shows.filter)
  }

  /** Up and Down, Home and End on any row. */
  const onRowsKey = (event: KeyboardEvent) => {
    const key = event.target instanceof HTMLElement ? event.target.dataset['sidebarRow'] : undefined
    if (key === undefined || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
      return
    const at = rowOrder.findIndex((r) => r.key === key)
    const moves: Record<string, Row | undefined> = {
      ArrowDown: rowOrder[at + 1],
      ArrowUp: rowOrder[at - 1],
      Home: rowOrder[0],
      End: rowOrder[rowOrder.length - 1],
    }
    if (!Object.hasOwn(moves, event.key)) return
    event.preventDefault()
    const to = moves[event.key]
    if (to !== undefined && to.key !== key) arrive(to)
  }
  // Next and Previous Sidebar Row, from anywhere: the view moves to the row
  // after or before the one shown, and the keyboard stays where it is.
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
  /** An open notebook with sub-notebooks: a notebook after it goes below all of them. */
  const openParent = (node: BookNode) => node.children.length > 0 && !collapsed.has(node.id)

  const toggle = (id: string, open?: boolean) =>
    setCollapsed((set) => {
      const next = new Set(set)
      const isOpen = !next.has(id)
      if (open ?? !isOpen) next.delete(id)
      else next.add(id)
      return next
    })

  const focusBook = (id: string) => {
    props.onSelect({ kind: 'book', id })
    rows.current.get(id)?.focus()
  }

  /** Runs a notebook action, from the menu or a key, on that notebook. */
  const runAction = (action: BookAction, node: PlacedNode) => {
    switch (action) {
      case 'newInside':
        // Open it, so the new notebook shows inside.
        toggle(node.id, true)
        return props.onCreateBook?.(node.id)
      case 'rename':
        return setEditing(node.id)
      case 'moveUp':
        return node.previousId && props.onPlaceBook(node.id, node.previousId, 'before')
      case 'moveDown':
        return node.nextId && props.onPlaceBook(node.id, node.nextId, 'after')
      case 'moveToTop':
        return props.onMoveBook(node.id, null)
      case 'aiAccess':
        return props.onSetAiAccess(node.id, !node.aiAccess)
      case 'exportMarkdown':
      case 'exportHtml':
        return props.onExportBook(action, node.id)
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

  /** Runs a tag action from its menu, on that tag. */
  const runTagAction = (action: TagAction, tag: TagMenuTarget) => {
    const color = colorOfAction(action)
    if (color !== undefined) return props.onSetTagColor(tag.id, color)
    switch (action) {
      case 'rename':
        return setEditingTag(tag.id)
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
  })
  const openTagMenu = async (tag: TagRecord, at?: MenuPoint) => {
    setTagMenuTarget(tag.id)
    await showTagMenu(tagTarget(tag), at)
    setTagMenuTarget((id) => (id === tag.id ? undefined : id))
  }

  const onKey = (event: KeyboardEvent, node: BookNode) => {
    if (event.target !== event.currentTarget) return
    if (heldCommandKey(event)) return event.preventDefault()
    const open = node.children.length > 0 && !collapsed.has(node.id)
    const go = (target: BookNode | undefined) => {
      if (!target) return
      event.preventDefault()
      arrive(libraryRow({ kind: 'book', id: target.id }))
    }
    // Up and Down go on to the rows around the tree (`onRowsKey`).
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault()
        if (node.children.length > 0 && !open) toggle(node.id, true)
        else if (open) go(node.children[0])
        return
      case 'ArrowLeft':
        event.preventDefault()
        if (open) toggle(node.id, false)
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

  /** Over a notebook row (`node`) or the Notebooks header (null). */
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
    const next: DropAt = { id: node?.id ?? null, zone: isBook && node ? zoneAt(event) : 'inside' }
    setDropAt((at) => (at?.id === next.id && at.zone === next.zone ? at : next))
  }

  const onDrop = (event: DragEvent, node: BookNode | null) => {
    event.preventDefault()
    setDropAt(undefined)
    const book = event.dataTransfer.getData(DRAG_BOOK)
    const note = event.dataTransfer.getData(DRAG_NOTE)
    if (book && node === null) {
      // The header: first at the top level.
      const first = tree[0]
      if (first && first.id !== book) props.onPlaceBook(book, first.id, 'before')
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

  // A drag that ends anywhere (dropped, or cancelled with the pointer still
  // over a row, when dragleave keeps the drop) ends the drop. Note drags
  // start in the note list, and a notebook row stops its own dragend.
  useEffect(() => {
    const clear = () => {
      setDropAt(undefined)
      setNoteDrop(undefined)
    }
    window.addEventListener('dragend', clear, true)
    window.addEventListener('drop', clear, true)
    return () => {
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('drop', clear, true)
    }
  }, [])

  /**
   * The drop classes for a notebook row. After an open notebook the line
   * goes on its item, under its sub-notebooks, where the notebook will go.
   */
  const dropClasses = (node: BookNode, part: 'item' | 'row') => {
    if (dropAt?.id !== node.id) return ''
    const onItem = dropAt.zone === 'after' && openParent(node)
    if ((part === 'item') !== onItem) return ''
    if (dropAt.zone === 'inside') return ' drop-target'
    if (dropAt.zone === 'before') return ' drop-before'
    return ' drop-after'
  }

  const renderNode = (node: BookNode) => {
    const isOpen = !collapsed.has(node.id)
    const isSelected = node.id === selectedBook
    const editingThis = nameEditing === node.id
    const row = rowProps(libraryRow({ kind: 'book', id: node.id }).key)
    return (
      <li
        key={node.id}
        className={dropClasses(node, 'item').trim() || undefined}
        style={{ '--book-depth': node.depth } as CSSProperties}
        data-sidebar-row={row['data-sidebar-row']}
        ref={(el) => {
          row.ref(el)
          if (el) rows.current.set(node.id, el)
          else rows.current.delete(node.id)
        }}
        role="treeitem"
        aria-level={node.depth + 1}
        aria-selected={isSelected}
        aria-expanded={node.children.length > 0 ? isOpen : undefined}
        tabIndex={row.tabIndex}
        draggable={!editingThis}
        onDragStart={(e) => {
          e.stopPropagation()
          e.dataTransfer.setData(DRAG_BOOK, node.id)
          e.dataTransfer.effectAllowed = 'move'
          dragging.current = subtree(tree, node.id)
        }}
        onDragEnd={(e) => {
          e.stopPropagation()
          dragging.current = undefined
          setDropAt(undefined)
        }}
        onKeyDown={(e) => onKey(e, node)}
        onClick={(e) => {
          e.stopPropagation()
          focusBook(node.id)
        }}
      >
        <div
          className={`book-row${dropClasses(node, 'row')}${menuTarget === node.id ? ' menu-target' : ''}`}
          onDoubleClick={() => setEditing(node.id)}
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
            {node.children.length > 0 ? (
              <Icon name={isOpen ? 'disclosure.open' : 'disclosure.closed'} size="sm" />
            ) : null}
          </span>
          <Icon name="notebook" size="md" />
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
        {node.children.length > 0 && isOpen ? (
          <ul role="group">{node.children.map(renderNode)}</ul>
        ) : null}
      </li>
    )
  }

  return (
    <nav
      className="sidebar"
      data-devot-part="sidebar"
      aria-label={t('sidebar.label')}
      onKeyDown={onRowsKey}
    >
      {/* The traffic lights sit here; the bar drags the window. */}
      <div className="titlebar" data-devot-part="sidebar-titlebar" data-tauri-drag-region>
        <button
          type="button"
          className="tool"
          aria-label={t('command.hideSidebar')}
          title={titleWithKey('sidebar.hideTitle', 'view.sidebar')}
          onClick={props.onHide}
        >
          <Icon name="sidebar.toggle" size="md" />
        </button>
      </div>
      <ul className="sources">
        <li>
          <button
            type="button"
            {...rowProps('all')}
            className="source"
            aria-current={selection?.kind === 'all' && props.filter === null}
            onClick={() => props.onSelect({ kind: 'all' })}
          >
            <Icon name="notes.all" size="md" />
            <span className="source-label">{t('sidebar.allNotes')}</span>
            <span className="source-count">{format(props.total)}</span>
          </button>
        </li>
        <li>
          {filterRow({ kind: 'pinned' }, 'notes.pinned', t('sidebar.pinned'), props.pinnedCount)}
        </li>
      </ul>
      <div
        className={`section-header${dropAt && dropAt.id === null ? ' drop-target' : ''}`}
        onDragEnter={(e) => onDragOver(e, null)}
        onDragOver={(e) => onDragOver(e, null)}
        onDragLeave={(e) => onDragLeave(e, null)}
        onDrop={(e) => onDrop(e, null)}
      >
        <span id="notebooks-heading">{t('sidebar.notebooks')}</span>
        <button
          type="button"
          className="tool tool-small"
          aria-label={t('book.new')}
          title={t('book.new')}
          onClick={() => props.onCreateBook?.(null)}
          disabled={!props.onCreateBook}
        >
          <Icon name="notebook.new" size="sm" />
        </button>
      </div>
      <ul className="books" role="tree" aria-labelledby="notebooks-heading">
        {tree.map(renderNode)}
      </ul>
      <div className="section-header">
        <span id="statuses-heading">{t('sidebar.statuses')}</span>
      </div>
      <ul className="sources" aria-labelledby="statuses-heading">
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
      {props.tags.length > 0 ? (
        <>
          <div className="section-header">
            <span id="tags-heading">{t('sidebar.tags')}</span>
          </div>
          <ul className="sources tags" aria-labelledby="tags-heading">
            {props.tags.map((tag) => (
              <li
                key={tag.id}
                onDoubleClick={() => setEditingTag(tag.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget.firstElementChild) return
                  if (heldCommandKey(e)) return e.preventDefault()
                  if (commandMatches('sidebar.rowMenu', e)) {
                    e.preventDefault()
                    return void openTagMenu(tag, below(e.target as Element))
                  }
                  const action = tagShortcut(e)
                  if (!action) return
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
                    { color: tag.color, onMenu: () => void openTagMenu(tag) },
                  )
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <ul className="sources trash-source">
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
        <li>
          <button
            type="button"
            {...rowProps('trash')}
            {...trashDrop.handlers}
            className={`source${trashDrop.className}`}
            aria-current={selection?.kind === 'trash'}
            onClick={() => props.onSelect({ kind: 'trash' })}
          >
            <Icon name="trash" size="md" />
            <span className="source-label">{t('sidebar.trash')}</span>
            <span className="source-count">{format(props.trashCount)}</span>
          </button>
        </li>
      </ul>
    </nav>
  )
})
