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
import { boardColumns, boardOrder, cardStep, columnWindow, type BoardColumn } from './board'
import { keyMatches } from './commands/keys'
import { commandMatches, heldCommandKey } from './commands/registry'
import type { MenuPoint } from './contextMenu'
import { DRAG_NOTE, setNoteDragData } from './dragData'
import { useEditorSetting } from './editorSettings'
import { fullDate, rowDate } from './format'
import { useHeadlines, type HeadlineLoader } from './headlines'
import { currentLocale, format, t } from './i18n'
import { Icon } from './icons/Icon'
import { dragCardLines, setDragCard } from './listDrag'
import { listEmpty, type ListEmptyKind } from './listEmpty'
import { ListHeader } from './ListHeader'
import {
  keyTarget,
  selectAll,
  selectRange,
  selectStep,
  selectToggle,
  type ListSelection,
} from './listSelection'
import { noteShortcut, type NoteAction } from './noteMenu'
import { spacerHeight } from './listWindow'
import { useNow } from './NoteList'
import type { WriterRef } from './authorshipLabels'
import { ChangedBy, STATUS_ICONS } from './NoteRow'
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
  /** The notes agents changed since the owner last looked, with the newest writer (agentWrites.ts). */
  changedBy?: ReadonlyMap<string, WriterRef> | undefined
  selected: string | undefined
  opening?: string | undefined
  onSelect: (id: string) => void
  onAction?: (action: NoteAction, id: string) => void
  onMenu?: (id: string, at?: MenuPoint) => void
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
  /** What the board says when the view has no notes. */
  empty?: ListEmptyKind | undefined
}

/** Boards with more cards than this render only the cards near the part of each column that shows (`columnWindow`), like a long list. */
const WINDOW_FROM = 200

type ColumnView = { top: number; height: number }

function withView(
  views: ReadonlyMap<NoteStatus, ColumnView>,
  status: NoteStatus,
  top: number,
  height: number,
): ReadonlyMap<NoteStatus, ColumnView> {
  const was = views.get(status)
  if (was?.top === top && was.height === height) return views
  return new Map(views).set(status, { top, height })
}

function spacer(key: string, height: number) {
  return <li key={key} className="rows-spacer" role="presentation" style={{ height }} />
}

const ARROWS: Readonly<Record<string, 'up' | 'down' | 'left' | 'right'>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}

// Only the Dropped column can be left off, so a view with notes and no cards holds dropped notes only.
const DROPPED_HIDDEN = { message: 'board.droppedHidden', tip: 'board.droppedHiddenTip' } as const

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
  const windowed = order.length > WINDOW_FROM
  const chosen = useMemo(() => (selection ? new Set(selection.ids) : undefined), [selection])
  const tabStop =
    selection && onBoard.has(selection.lead)
      ? selection.lead
      : selected !== undefined && onBoard.has(selected)
        ? selected
        : order[0]
  const [focusedCard, setFocusedCard] = useState<string>()
  const [revealed, setRevealed] = useState<string>()
  const toFocus = useRef<string>(undefined)
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [metrics, setMetrics] = useState({ gap: 0, padding: 0 })
  const [views, setViews] = useState<ReadonlyMap<NoteStatus, ColumnView>>(() => new Map())
  const windows = useMemo(() => {
    if (!windowed) return undefined
    let sum = 0
    for (const h of heights.values()) sum += h
    const estimate = heights.size > 0 ? sum / heights.size : 0
    const heightOf = (id: string) => heights.get(id) ?? estimate
    const kept = new Set<string>()
    for (const id of [selected, tabStop, focusedCard, revealed]) if (id !== undefined) kept.add(id)
    return new Map(
      columns.map((column) => {
        const seen = views.get(column.status)
        const view =
          seen && heights.size > 0
            ? { top: seen.top - metrics.padding, height: seen.height }
            : undefined
        const ids = column.notes.map((n) => n.id)
        return [column.status, columnWindow(ids, heightOf, metrics.gap, view, kept)] as const
      }),
    )
  }, [windowed, heights, columns, views, metrics, selected, tabStop, focusedCard, revealed])
  const rendered = useMemo(
    () =>
      columns.flatMap((column) => {
        const runs = windows?.get(column.status)?.runs
        if (!runs) return column.notes
        return runs.flatMap(([start, end]) => column.notes.slice(start, end))
      }),
    [columns, windows],
  )
  const headlines = useHeadlines(props.headlines, rendered)
  const now = useNow()
  const locale = currentLocale()
  const dates = useEditorSetting('listDates')
  const { width, edge } = usePaneResize(BOARD_PANE)

  const idBase = useId()
  const board = useRef<HTMLElement>(null)
  const cards = useRef(new Map<string, HTMLLIElement>())
  const focusFirstColumn = () => board.current?.querySelector<HTMLElement>('.board-cards')?.focus()
  /** Gives `id`'s card the keyboard and scrolls it into view; a card a long board has not rendered renders first. */
  const focusCard = (id: string) => {
    const card = cards.current.get(id)
    if (!card) {
      toFocus.current = id
      setRevealed(id)
      return
    }
    card.focus({ preventScroll: true })
    card.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  useEffect(() => {
    const id = toFocus.current
    const card = id === undefined ? undefined : cards.current.get(id)
    if (!card) return
    toFocus.current = undefined
    card.focus({ preventScroll: true })
    card.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })

  // On a long board, measures the cards and each column (gap, padding, height) as they change.
  const [sizes] = useState(
    () =>
      new ResizeObserver((changes) => {
        const measured = new Map<string, number>()
        for (const change of changes) {
          const el = change.target as HTMLElement
          if (!el.isConnected) continue
          if (el instanceof HTMLUListElement) {
            const style = getComputedStyle(el)
            const gap = parseFloat(style.rowGap) || 0
            const padding = parseFloat(style.paddingTop) || 0
            setMetrics((m) => (m.gap === gap && m.padding === padding ? m : { gap, padding }))
            const status = el.dataset['status'] as NoteStatus | undefined
            if (status) setViews((v) => withView(v, status, el.scrollTop, el.clientHeight))
            continue
          }
          const id = el.dataset['noteId']
          if (id !== undefined) measured.set(id, el.getBoundingClientRect().height)
        }
        if (measured.size === 0) return
        setHeights((known) => {
          let next: Map<string, number> | undefined
          for (const [id, height] of measured) {
            if (known.get(id) === height) continue
            next ??= new Map(known)
            next.set(id, height)
          }
          return next ?? known
        })
      }),
  )
  useEffect(() => {
    const el = board.current
    if (!windowed || !el) return
    for (const part of el.querySelectorAll<HTMLElement>('.board-cards, .card')) sizes.observe(part)
    return () => sizes.disconnect()
  }, [windowed, sizes])
  const observeColumn = useStable((el: HTMLUListElement | null) => {
    if (!el || !windowed) return
    sizes.observe(el)
    return () => sizes.unobserve(el)
  })

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
      if (id !== undefined) setFocusedCard(id)
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
    if (next === undefined) return focusFirstColumn()
    focusCard(next)
    if (selected === undefined || selected === held) onSelect(next)
  })

  // A note opened from elsewhere shows; while the board has the keyboard its card takes it.
  // `navigated` is the card the board opened itself, already focused: an older
  // selection that lands after it must not pull the keyboard back (quick arrow keys).
  const shownOpen = useRef(selected)
  const navigated = useRef<string>(undefined)
  useEffect(() => {
    if (shownOpen.current === selected) return
    shownOpen.current = selected
    if (navigated.current !== undefined) {
      if (navigated.current === selected) navigated.current = undefined
      return
    }
    const card = selected === undefined ? undefined : cards.current.get(selected)
    if (!card) return
    card.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const active = document.activeElement
    if (active && active !== card && board.current?.contains(active) && !chosen) {
      card.focus({ preventScroll: true })
    }
  }, [selected, chosen])

  const open = (id: string) => {
    if (id !== selected || navigated.current !== undefined) navigated.current = id
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
    // A held Shift+Down keeps extending the selection, as the key repeats.
    const by = commandMatches('list.extendDown', event, true)
      ? 1
      : commandMatches('list.extendUp', event, true)
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
    const target = keyTarget(selection, selected, id)
    if (props.onMenu && commandMatches('list.rowMenu', event)) {
      event.preventDefault()
      const box = cards.current.get(id)?.getBoundingClientRect()
      return props.onMenu(target, box ? { x: box.left, y: box.bottom } : undefined)
    }
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
  const setCard = useStable((id: string, el: HTMLLIElement) => {
    cards.current.set(id, el)
    if (windowed) sizes.observe(el)
    return () => {
      sizes.unobserve(el)
      if (cards.current.get(id) === el) cards.current.delete(id)
    }
  })
  const events = useMemo<CardEvents>(
    () => ({ setCard, click, dragStart, keyDown: cardKey, contextMenu }),
    [setCard, click, dragStart, cardKey, contextMenu],
  )

  const renderCard = (note: NoteSummary, index: number, count: number) => (
    <BoardCard
      key={note.id}
      note={note}
      selected={chosen ? chosen.has(note.id) : note.id === (props.opening ?? selected)}
      open={note.id === selected}
      tabbable={note.id === tabStop}
      position={windows ? index + 1 : undefined}
      setSize={windows ? count : undefined}
      tags={props.tags}
      changedBy={props.changedBy?.get(note.id)}
      headline={headlines.get(note.id)}
      now={now}
      locale={locale}
      dates={dates}
      draggable={props.onMove !== undefined}
      dragging={dragged?.has(note.id) ?? false}
      menu={props.onMenu !== undefined}
      events={events}
    />
  )
  const cardsOf = (column: BoardColumn<NoteSummary>): ReactNode[] => {
    const cardsHere = column.notes
    const shownWindow = windows?.get(column.status)
    if (!shownWindow) return cardsHere.map((n, i) => renderCard(n, i, cardsHere.length))
    const { runs, offsets } = shownWindow
    const gap = metrics.gap
    const out: ReactNode[] = []
    let from = 0
    for (const [start, end] of runs) {
      if (start > from) out.push(spacer(`spacer:${from}`, spacerHeight(offsets, from, start, gap)))
      for (let i = start; i < end; i += 1) out.push(renderCard(cardsHere[i]!, i, cardsHere.length))
      from = end
    }
    if (cardsHere.length > from) {
      out.push(spacer(`spacer:${from}`, spacerHeight(offsets, from, cardsHere.length, gap)))
    }
    return out
  }
  const emptyText =
    props.empty && notes.length === 0
      ? listEmpty(props.empty)
      : notes.length > 0 && order.length === 0
        ? DROPPED_HIDDEN
        : undefined

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
          else focusFirstColumn()
        }}
      />
      {emptyText ? (
        <div className="list-empty">
          <span className="list-empty-message">{t(emptyText.message)}</span>
          {emptyText.tip ? <span className="list-empty-tip">{t(emptyText.tip)}</span> : null}
        </div>
      ) : (
        <div className="board-columns">
          {columns.map((column) => {
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
                  ref={observeColumn}
                  className="board-cards"
                  data-status={column.status}
                  role="listbox"
                  aria-labelledby={headingId}
                  aria-multiselectable
                  tabIndex={-1}
                  onKeyDown={columnKey}
                  onScroll={
                    windowed
                      ? (e) => {
                          const el = e.currentTarget
                          setViews((v) => withView(v, column.status, el.scrollTop, el.clientHeight))
                        }
                      : undefined
                  }
                >
                  {cardsOf(column)}
                </ul>
              </div>
            )
          })}
        </div>
      )}
      <div className="list-resize" aria-label={t('board.resize')} {...edge} />
    </section>
  )
})

interface CardEvents {
  setCard: (id: string, el: HTMLLIElement) => () => void
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
  position: number | undefined
  setSize: number | undefined
  tags: ReadonlyMap<string, TagRecord>
  changedBy: WriterRef | undefined
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
  const ref = useCallback((el: HTMLLIElement) => events.setCard(id, el), [events, id])
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
      aria-posinset={props.position}
      aria-setsize={props.setSize}
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
        {props.changedBy ? <ChangedBy writer={props.changedBy} compact /> : null}
        {tags.length > 0 ? (
          <span className="card-tags">
            {tags.map((tag) => (
              <span
                key={tag.id}
                className={tag.color ? `tag-dot tag-color-${tag.color}` : 'tag-dot card-tag-plain'}
                aria-hidden
                title={tag.name}
              />
            ))}
            <span className="visually-hidden">
              {format(t('board.cardTags'), { tags: tags.map((tag) => tag.name).join(', ') })}
            </span>
          </span>
        ) : null}
      </span>
    </li>
  )
})
