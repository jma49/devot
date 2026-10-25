import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react'
import type { NoteSummary, TagRecord } from '../../core'
import type { NoteStatus } from '../../core/storage'
import type { ListDatesStyle } from '../../core/editorSettings'
import { boardColumns, boardOrder, cardStep } from './board'
import { keyMatches } from './commands/keys'
import { commandMatches, heldCommandKey } from './commands/registry'
import type { MenuPoint } from './contextMenu'
import { DRAG_NOTE, setNoteDragData } from './dragData'
import { useEditorSetting } from './editorSettings'
import { fullDate, rowDate } from './format'
import { useHeadlines, type HeadlineLoader } from './headlines'
import { currentLocale, t } from './i18n'
import { Icon } from './icons/Icon'
import { dragCardLines, setDragCard } from './listDrag'
import { ListHeader } from './ListHeader'
import {
  selectAll,
  selectRange,
  selectStep,
  selectToggle,
  type ListSelection,
} from './listSelection'
import { noteShortcut, type NoteAction } from './noteMenu'
import { useNow } from './NoteList'
import { STATUS_ICONS } from './NoteRow'
import { usePaneResize } from './paneResize'
import { BOARD_PANE } from './paneWidth'
import { useStable } from './stable'

interface Props {
  view: string
  title: string
  scope?: string | undefined
  icon?: ReactNode
  onTitleMenu?: ((at: MenuPoint) => void) | undefined
  leading?: ReactNode
  onCreate: (() => void) | undefined
  filter?: ReactNode
  sort?: { label: string; chip: string; onOpen: (anchor: HTMLElement) => void }
  sortButtonRef?: Ref<HTMLButtonElement>
  layout?: ReactNode
  /** The notes the view lists, in its order; each shows in its status's column. */
  notes: readonly NoteSummary[]
  statuses: readonly NoteStatus[]
  tags: ReadonlyMap<string, TagRecord>
  selected: string | undefined
  opening?: string | undefined
  onSelect: (id: string) => void
  onAction?: (action: NoteAction, id: string) => void
  onMenu?: (id: string) => void
  onFind?: () => void
  onEdit?: (part: 'title' | 'body', id: string) => void
  selection: ListSelection | undefined
  onSelection: (next: ListSelection | undefined) => void
  headlines?: HeadlineLoader | undefined
  /** Gives the notes a status (a drop, a key); undefined while notes cannot be changed, when cards do not drag either. */
  onMove?: ((ids: readonly string[], status: NoteStatus) => void) | undefined
  /** Moves each note one column on (Control+Command+Right and Left). */
  onStep?: ((ids: readonly string[], by: 1 | -1) => void) | undefined
  onUndo?: (() => void) | undefined
  onRedo?: (() => void) | undefined
}

const ARROWS: Readonly<Record<string, 'up' | 'down' | 'left' | 'right'>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}

const takesNotes = (event: DragEvent) => event.dataTransfer.types.includes(DRAG_NOTE)

/**
 * The note list as a board: a column per status (`statuses`), each a listbox
 * of cards; every column shows, empty ones too, and takes dropped cards. The
 * selection, the drag and the note keys are the list's; the arrow keys move
 * between cards and columns.
 */
export const NoteBoard = memo(function NoteBoard(props: Props) {
  const { notes, statuses, selected, selection, onSelection, onSelect } = props
  const columns = useMemo(() => boardColumns(notes, statuses), [notes, statuses])
  const order = useMemo(() => boardOrder(columns), [columns])
  const byId = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes])
  const onBoard = useMemo(() => new Set(order), [order])
  const chosen = useMemo(() => (selection ? new Set(selection.ids) : undefined), [selection])
  const tabStop =
    selection && onBoard.has(selection.lead)
      ? selection.lead
      : selected !== undefined && onBoard.has(selected)
        ? selected
        : order[0]
  const shownNotes = useMemo(() => order.flatMap((id) => byId.get(id) ?? []), [order, byId])
  const headlines = useHeadlines(props.headlines, shownNotes)
  const now = useNow()
  const locale = currentLocale()
  const dates = useEditorSetting('listDates')
  const { width, edge } = usePaneResize(BOARD_PANE)

  const idBase = useId()
  const board = useRef<HTMLElement>(null)
  const cards = useRef(new Map<string, HTMLLIElement>())
  const firstColumn = useRef<HTMLUListElement>(null)
  const focusCard = (id: string) => {
    const card = cards.current.get(id)
    card?.focus({ preventScroll: true })
    card?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  // The card that has the keyboard. A move puts its card in another column,
  // a new element: it takes the keyboard again in the commit that moved it.
  // A card that left the board hands it to the next card it had, else the
  // previous one, else the board.
  const keyboard = useRef<string>(undefined)
  const shown = useRef<{ view: string; order: readonly string[] }>({ view: props.view, order: [] })
  useEffect(() => {
    const el = board.current
    if (!el) return
    const onFocusIn = (e: FocusEvent) => {
      const id = e.target instanceof HTMLElement ? e.target.dataset['noteId'] : undefined
      keyboard.current = id
    }
    const onFocusOut = (e: FocusEvent) => {
      const from = e.target
      const to = e.relatedTarget
      if (to instanceof Node) {
        if (!el.contains(to)) keyboard.current = undefined
        return
      }
      queueMicrotask(() => {
        const active = document.activeElement
        const away = !active || active === document.body
        if (away && from instanceof Node && from.isConnected) keyboard.current = undefined
      })
    }
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', onFocusOut)
    return () => {
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('focusout', onFocusOut)
    }
  }, [])
  useLayoutEffect(() => {
    const before = shown.current
    shown.current = { view: props.view, order }
    const held = keyboard.current
    if (held === undefined) return
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    if (before.view !== props.view) {
      keyboard.current = undefined
      return
    }
    if (onBoard.has(held)) return focusCard(held)
    keyboard.current = undefined
    const at = before.order.indexOf(held)
    const next =
      before.order.slice(at + 1).find((id) => onBoard.has(id)) ??
      before.order.slice(0, Math.max(at, 0)).findLast((id) => onBoard.has(id))
    if (next === undefined) return firstColumn.current?.focus()
    focusCard(next)
    if (selected === undefined || selected === held) onSelect(next)
  })

  // A note opened from elsewhere shows; while the board has the keyboard its card takes it.
  const shownOpen = useRef(selected)
  useEffect(() => {
    if (shownOpen.current === selected) return
    shownOpen.current = selected
    const card = selected === undefined ? undefined : cards.current.get(selected)
    if (!card) return
    card.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const active = document.activeElement
    if (active && active !== card && board.current?.contains(active) && !chosen) {
      card.focus({ preventScroll: true })
    }
  }, [selected, chosen])

  const open = (id: string) => {
    focusCard(id)
    onSelect(id)
  }

  /** The notes a key or drag on `id` acts on: the selection when it holds `id`, else that note. */
  const idsFor = (id: string): readonly string[] =>
    chosen?.has(id) && selection ? selection.ids : [id]

  const selectionKey = (event: KeyboardEvent): boolean => {
    if (commandMatches('list.selectAll', event)) {
      event.preventDefault()
      const next = selectAll(selection, selected, order)
      if (next) onSelection(next)
      return true
    }
    if (selection && commandMatches('list.clearSelection', event)) {
      event.preventDefault()
      onSelection(undefined)
      if (selected !== undefined) focusCard(selected)
      return true
    }
    const by = commandMatches('list.extendDown', event)
      ? 1
      : commandMatches('list.extendUp', event)
        ? -1
        : 0
    if (!by) return false
    event.preventDefault()
    const next = selectStep(selection, selected, by, order)
    if (!next) return true
    focusCard(next.lead)
    onSelection(next)
    return true
  }

  /** Undo and Redo of the Edit menu, which the page sees first: a board move is one step. */
  const undoKey = (event: KeyboardEvent): boolean => {
    const undo = keyMatches('Mod+Z', event)
    const redo = keyMatches('Mod+Shift+Z', event)
    if (!undo && !redo) return false
    event.preventDefault()
    if (!event.repeat) (undo ? props.onUndo : props.onRedo)?.()
    return true
  }

  const cardKey = useStable((id: string, event: KeyboardEvent<HTMLLIElement>) => {
    if (heldCommandKey(event)) {
      event.preventDefault()
      return
    }
    if (selectionKey(event) || undoKey(event)) return
    const by = commandMatches('status.next', event)
      ? 1
      : commandMatches('status.previous', event)
        ? -1
        : 0
    if (by) {
      event.preventDefault()
      if (!event.repeat) props.onStep?.(idsFor(id), by)
      return
    }
    const target = chosen ? (selected ?? id) : id
    const action = props.onAction ? noteShortcut(event) : undefined
    if (action) {
      event.preventDefault()
      return props.onAction?.(action, target)
    }
    if (props.onFind && commandMatches('search.fromList', event)) {
      event.preventDefault()
      return props.onFind()
    }
    const part = commandMatches('note.editTitle', event)
      ? 'title'
      : commandMatches('note.editBody', event)
        ? 'body'
        : undefined
    if (part && props.onEdit) {
      event.preventDefault()
      return props.onEdit(part, target)
    }
    const direction = ARROWS[event.key]
    if (!direction || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    const next = cardStep(columns, id, direction)
    if (next !== undefined) open(next)
  })

  /** Keys on a column itself, which has the keyboard while no card can: an arrow opens the first card. */
  const columnKey = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.target !== event.currentTarget) return
    if (selectionKey(event) || undoKey(event)) return
    if (props.onFind && commandMatches('search.fromList', event)) {
      event.preventDefault()
      return props.onFind()
    }
    const first = order[0]
    if (!ARROWS[event.key] || first === undefined) return
    event.preventDefault()
    open(first)
  }

  const click = useStable((id: string, event: MouseEvent<HTMLLIElement>) => {
    const gesture = event.metaKey ? selectToggle : event.shiftKey ? selectRange : undefined
    if (!gesture) return open(id)
    event.currentTarget.focus()
    onSelection(gesture(selection, selected, id, order))
  })

  const [dragged, setDragged] = useState<ReadonlySet<string>>()
  const [dropOn, setDropOn] = useState<NoteStatus>()
  useEffect(() => {
    if (!dragged) return
    const end = () => {
      setDragged(undefined)
      setDropOn(undefined)
    }
    window.addEventListener('dragend', end, true)
    window.addEventListener('drop', end, true)
    return () => {
      window.removeEventListener('dragend', end, true)
      window.removeEventListener('drop', end, true)
    }
  }, [dragged])
  const dragStart = useStable((id: string, event: DragEvent<HTMLLIElement>) => {
    const ids = idsFor(id)
    const picked = ids.map((noteId) => ({
      id: noteId,
      title: byId.get(noteId)?.title || headlines.get(noteId) || t('note.untitled'),
    }))
    setNoteDragData(event.dataTransfer, picked)
    setDragCard(
      event.dataTransfer,
      dragCardLines(
        picked.map((n) => n.title),
        locale,
      ),
    )
    setDragged(new Set(ids))
  })
  const dropTarget = (status: NoteStatus) => {
    const { onMove } = props
    if (!onMove) return {}
    const over = (event: DragEvent) => {
      if (!takesNotes(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDropOn(status)
    }
    return {
      onDragEnter: over,
      onDragOver: over,
      onDragLeave: (event: DragEvent) => {
        const to = event.relatedTarget
        if (to instanceof Node && event.currentTarget.contains(to)) return
        setDropOn((on) => (on === status ? undefined : on))
      },
      onDrop: (event: DragEvent) => {
        if (!takesNotes(event)) return
        event.preventDefault()
        setDropOn(undefined)
        const ids = event.dataTransfer
          .getData(DRAG_NOTE)
          .split('\n')
          .filter((id) => byId.has(id))
        if (ids.length > 0) onMove(ids, status)
      },
    }
  }

  const contextMenu = useStable((id: string, event: MouseEvent<HTMLLIElement>) => {
    event.preventDefault()
    props.onMenu?.(id)
  })
  const setCard = useStable((id: string, el: HTMLLIElement | null) => {
    if (el) cards.current.set(id, el)
    else if (cards.current.get(id)?.isConnected === false) cards.current.delete(id)
  })
  const events = useMemo<CardEvents>(
    () => ({ setCard, click, dragStart, keyDown: cardKey, contextMenu }),
    [setCard, click, dragStart, cardKey, contextMenu],
  )

  return (
    <section
      ref={board}
      className="list board"
      data-devot-part="list"
      aria-label={t('noteList.label')}
      style={{ '--list-width': `${width}px` } as CSSProperties}
    >
      <ListHeader
        title={props.title}
        scope={props.scope}
        count={order.length}
        icon={props.icon}
        onTitleMenu={props.onTitleMenu}
        leading={props.leading}
        onCreate={props.onCreate}
        filter={props.filter}
        sort={props.sort}
        sortButtonRef={props.sortButtonRef}
        layout={props.layout}
        onFilterDone={() => {
          if (tabStop !== undefined) focusCard(tabStop)
          else firstColumn.current?.focus()
        }}
      />
      <div className="board-columns">
        {columns.map((column, i) => {
          const headingId = `${idBase}-${column.status}`
          return (
            <div
              key={column.status}
              className={`board-column status-${column.status}`}
              data-status={column.status}
              data-drop={dropOn === column.status || undefined}
              {...dropTarget(column.status)}
            >
              <div className="board-column-header" id={headingId}>
                <Icon name={STATUS_ICONS[column.status]} size="sm" />
                <span className="board-column-name">{t(`status.${column.status}`)}</span>
                <span className="board-count">{column.notes.length}</span>
              </div>
              <ul
                ref={i === 0 ? firstColumn : undefined}
                className="board-cards"
                role="listbox"
                aria-labelledby={headingId}
                aria-multiselectable
                tabIndex={-1}
                onKeyDown={columnKey}
              >
                {column.notes.map((note) => (
                  <BoardCard
                    key={note.id}
                    note={note}
                    selected={
                      chosen ? chosen.has(note.id) : note.id === (props.opening ?? selected)
                    }
                    open={note.id === selected}
                    tabbable={note.id === tabStop}
                    tags={props.tags}
                    headline={headlines.get(note.id)}
                    now={now}
                    locale={locale}
                    dates={dates}
                    draggable={props.onMove !== undefined}
                    dragging={dragged?.has(note.id) ?? false}
                    menu={props.onMenu !== undefined}
                    events={events}
                  />
                ))}
              </ul>
            </div>
          )
        })}
      </div>
      <div className="list-resize" aria-label={t('board.resize')} {...edge} />
    </section>
  )
})

interface CardEvents {
  setCard: (id: string, el: HTMLLIElement | null) => void
  click: (id: string, event: MouseEvent<HTMLLIElement>) => void
  dragStart: (id: string, event: DragEvent<HTMLLIElement>) => void
  keyDown: (id: string, event: KeyboardEvent<HTMLLIElement>) => void
  contextMenu: (id: string, event: MouseEvent<HTMLLIElement>) => void
}

interface CardProps {
  note: NoteSummary
  selected: boolean
  open: boolean
  tabbable: boolean
  tags: ReadonlyMap<string, TagRecord>
  headline: string | undefined
  now: number
  locale: string
  dates: ListDatesStyle
  draggable: boolean
  dragging: boolean
  menu: boolean
  events: CardEvents
}

/** One note on the board: its title (an untitled note's first line), when it changed and its tags as dots. */
const BoardCard = memo(function BoardCard(props: CardProps) {
  const { note: n, events } = props
  const id = n.id
  const ref = useCallback((el: HTMLLIElement | null) => events.setCard(id, el), [events, id])
  const tags = n.tagIds.flatMap((tagId) => {
    const tag = props.tags.get(tagId)
    return tag ? [tag] : []
  })
  return (
    <li
      ref={ref}
      className="card"
      data-note-id={id}
      role="option"
      aria-selected={props.selected}
      data-open={props.open || undefined}
      tabIndex={props.tabbable ? 0 : -1}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault()
      }}
      onClick={(e) => events.click(id, e)}
      draggable={props.draggable}
      data-dragging={props.dragging || undefined}
      onDragStart={(e) => events.dragStart(id, e)}
      onKeyDown={(e) => events.keyDown(id, e)}
      onContextMenu={props.menu ? (e) => events.contextMenu(id, e) : undefined}
    >
      <span className={n.title ? 'card-title' : 'card-title card-headline'}>
        {n.title || props.headline || t('note.untitled')}
      </span>
      <span className="card-meta">
        <time
          className="card-time"
          dateTime={new Date(n.updatedAt).toISOString()}
          title={fullDate(n.updatedAt, props.locale)}
        >
          {rowDate(n.updatedAt, props.now, props.locale, props.dates)}
        </time>
        {tags.length > 0 ? (
          <span className="card-tags">
            {tags.map((tag) => (
              <span
                key={tag.id}
                className={tag.color ? `tag-dot tag-color-${tag.color}` : 'tag-dot card-tag-plain'}
                role="img"
                aria-label={tag.name}
                title={tag.name}
              />
            ))}
          </span>
        ) : null}
      </span>
    </li>
  )
})
