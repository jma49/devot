import {
  memo,
  useCallback,
  useEffect,
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
import type { NoteSummary, TagRecord, TaskProgress } from '../../core'
import type { ListDatesStyle } from '../../core/editorSettings'
import type { WriterRef } from './authorshipLabels'
import { CardMeta } from './CardMeta'
import { dropSelectionLeftBehind } from './focus'
import { commandMatches, heldCommandKey } from './commands/registry'
import type { MenuPoint } from './contextMenu'
import { setNoteDragData } from './dragData'
import { useEditorSetting } from './editorSettings'
import {
  galleryCardHeight,
  galleryColumns,
  galleryGridTop,
  galleryPlace,
  galleryReveal,
  galleryScale,
  galleryStep,
  galleryWindow,
} from './gallery'
import { useCardPreviews, type CardPreview, type CardPreviewLoader } from './galleryPreviews'
import { displayTitle, useHeadlines, type HeadlineLoader } from './headlines'
import { currentLocale, t } from './i18n'
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
import { jumpIndex } from './listWindow'
import { useNow } from './NoteList'
import { noteShortcut, type NoteAction } from './noteMenu'
import { usePaneResize } from './paneResize'
import { BOARD_PANE } from './paneWidth'
import { patchChildren } from './preview/dom'
import { useRowMotion } from './rowMotion'
import { usePendingFocus } from './pendingFocus'
import { useStable } from './stable'
import { sizes } from './theme/tokens'

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
  /** The notes the view lists, in its order (pinned first). */
  notes: readonly NoteSummary[]
  tags: ReadonlyMap<string, TagRecord>
  /** The notes agents changed since the owner last looked, with the newest writer (agentWrites.ts). */
  changedBy?: ReadonlyMap<string, WriterRef> | undefined
  /** The pane's width until the user sets one: the board's for the view (`fittedBoardWidth`), whose width the gallery shares. */
  fittedWidth: number
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
  taskCounts?: HeadlineLoader<TaskProgress> | undefined
  previews?: CardPreviewLoader | undefined
  /** Whether cards drag (to the sidebar's notebooks, tags, statuses and Trash). */
  draggable: boolean
  empty?: ListEmptyKind | undefined
  editing?: boolean
  /** More matched than the cards shown (a capped search). */
  capped?: boolean | undefined
}

const px = (value: string) => Number.parseFloat(value)
const CARD_MIN_WIDTH = px(sizes['size.gallery-card-min-width'])
const CARD_MAX_WIDTH = px(sizes['size.gallery-card-max-width'])
const PAGE_WIDTH = px(sizes['size.gallery-page-width'])
/** `.gallery-grid` gap, the cell's padding (top and sides), the sheet's side padding, and what is under the sheet (caption margin, line and the cell's bottom padding), in app.css. */
const GAP = px(sizes['space.5'])
const CELL_INSET = px(sizes['space.2'])
const PAGE_INSET = 2 * CELL_INSET + 2 * px(sizes['space.4'])
const BELOW_SHEET = 2 * px(sizes['space.3']) + px(sizes['size.card-meta-line'])
const OVERSCAN_PX = 600

interface Grid {
  width: number
  top: number
  height: number
}

const gridTop = (outer: HTMLElement, inner: HTMLElement) =>
  galleryGridTop(
    {
      top: outer.getBoundingClientRect().top,
      scrollTop: outer.scrollTop,
      clientTop: outer.clientTop,
    },
    inner.getBoundingClientRect(),
  )

/**
 * The note list as a gallery: one listbox of cards in rows, each a thumbnail
 * of the note's first page (its title, then the start of its body). The selection, the
 * drag and the note keys are the list's; the arrow keys move across the grid.
 * Only the rows near the part that shows render (`galleryWindow`), and only
 * their thumbnails are read.
 */
export const NoteGallery = memo(function NoteGallery(props: Props) {
  const { notes, selected, selection, onSelection, onSelect } = props
  const order = useMemo(() => notes.map((n) => n.id), [notes])
  const indexOf = useMemo(() => new Map(order.map((id, i) => [id, i])), [order])
  const chosen = useMemo(() => (selection ? new Set(selection.ids) : undefined), [selection])
  const tabStop =
    selection && indexOf.has(selection.lead)
      ? selection.lead
      : selected !== undefined && indexOf.has(selected)
        ? selected
        : order[0]
  const [focusedCard, setFocusedCard] = useState<string>()
  const list = useRef<HTMLUListElement>(null)
  const cards = useRef(new Map<string, HTMLLIElement>())
  const pending = usePendingFocus({
    view: props.view,
    listed: (id) => indexOf.has(id),
    element: (id) => cards.current.get(id),
    container: () => list.current,
    take: (card) => card.focus({ preventScroll: true }),
  })
  const revealed = pending.revealed
  const [grid, setGrid] = useState<Grid>({ width: 0, top: 0, height: 0 })
  const columns = galleryColumns(grid.width, CARD_MIN_WIDTH, CARD_MAX_WIDTH, GAP)
  const cardWidth = Math.max(0, (grid.width - GAP * (columns - 1)) / columns)
  const cardHeight = galleryCardHeight(cardWidth, CELL_INSET, BELOW_SHEET)
  const rowStep = cardHeight + GAP
  const rows = Math.ceil(notes.length / columns)
  const shown = useMemo(() => {
    const kept: number[] = []
    for (const id of [selected, tabStop, focusedCard, revealed]) {
      const i = id === undefined ? undefined : indexOf.get(id)
      if (i !== undefined) kept.push(i)
    }
    const view = grid.height > 0 ? { top: grid.top, height: grid.height } : null
    return galleryWindow(notes.length, columns, rowStep, view, OVERSCAN_PX, kept)
  }, [notes.length, columns, rowStep, grid, selected, tabStop, focusedCard, revealed, indexOf])
  const rendered = useMemo(() => shown.map((i) => notes[i]!), [shown, notes])
  const headlines = useHeadlines(props.headlines, rendered)
  const taskCounts = useHeadlines(props.taskCounts, rendered, true)
  const previews = useCardPreviews(props.previews, rendered)
  const locale = currentLocale()
  const now = useNow()
  const dates = useEditorSetting('listDates')
  const { width, edge } = usePaneResize(BOARD_PANE, props.fittedWidth)
  const emptyText =
    props.empty && notes.length === 0 ? listEmpty(props.empty, props.editing) : undefined

  const scroller = useRef<HTMLDivElement>(null)
  useRowMotion(() => list.current, 'data-note-id', order, props.view, 'grow')

  const measure = useStable(() => {
    const outer = scroller.current
    const inner = list.current
    if (!outer || !inner) return
    const next = {
      width: inner.clientWidth,
      top: Math.max(0, outer.scrollTop - gridTop(outer, inner)),
      height: outer.clientHeight,
    }
    setGrid((was) =>
      was.width === next.width && was.top === next.top && was.height === next.height ? was : next,
    )
  })
  /** Scrolls the card at `index` into view, rendered or not: every card's place is known. */
  const reveal = (index: number) => {
    const outer = scroller.current
    const inner = list.current
    if (!outer || !inner || index < 0) return
    const view = {
      gridTop: gridTop(outer, inner),
      scrollTop: outer.scrollTop,
      height: outer.clientHeight,
    }
    const top = galleryReveal(index, columns, rowStep, cardHeight, view)
    if (top !== outer.scrollTop) outer.scrollTop = top
  }
  /** Gives `id`'s card the keyboard and scrolls it into view; a card not rendered yet renders first. */
  const focusCard = (id: string) => {
    reveal(indexOf.get(id) ?? -1)
    const card = cards.current.get(id)
    if (card) return card.focus({ preventScroll: true })
    pending.request(id)
  }

  // The card that has the keyboard. One that left the gallery (Move to Trash,
  // a filter that hides it) hands it to the next card it had, else the
  // previous one, else the grid.
  const keyboard = useRef<string>(undefined)
  const shownBefore = useRef<{ view: string; order: readonly string[] }>({
    view: props.view,
    order: [],
  })
  // Native listeners: React ignores focus changes made while it commits, such
  // as a closing dialog giving the keyboard back to its card.
  const gridRef = useCallback(
    (el: HTMLUListElement) => {
      list.current = el
      const onFocusIn = (e: FocusEvent) => {
        const id = e.target instanceof HTMLElement ? e.target.dataset['noteId'] : undefined
        keyboard.current = id
        setFocusedCard(id)
        if (id !== undefined) dropSelectionLeftBehind(document, e.target as HTMLElement)
      }
      const left = () => {
        keyboard.current = undefined
        setFocusedCard(undefined)
      }
      const onFocusOut = (e: FocusEvent) => {
        const from = e.target
        const to = e.relatedTarget
        if (to instanceof Node) {
          if (!el.contains(to)) left()
          return
        }
        queueMicrotask(() => {
          const active = document.activeElement
          const away = !active || active === document.body
          if (away && from instanceof Node && from.isConnected) left()
        })
      }
      el.addEventListener('focusin', onFocusIn)
      el.addEventListener('focusout', onFocusOut)
      const resized = new ResizeObserver(() => measure())
      resized.observe(el)
      if (el.parentElement) resized.observe(el.parentElement)
      measure()
      return () => {
        el.removeEventListener('focusin', onFocusIn)
        el.removeEventListener('focusout', onFocusOut)
        resized.disconnect()
        if (list.current === el) list.current = null
      }
    },
    [measure],
  )
  useLayoutEffect(() => {
    const before = shownBefore.current
    shownBefore.current = { view: props.view, order }
    const held = keyboard.current
    if (held === undefined || indexOf.has(held)) return
    keyboard.current = undefined
    if (before.view !== props.view) return
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    const at = before.order.indexOf(held)
    const next =
      before.order.slice(at + 1).find((id) => indexOf.has(id)) ??
      before.order.slice(0, Math.max(at, 0)).findLast((id) => indexOf.has(id))
    if (next === undefined) return list.current?.focus()
    focusCard(next)
    if (selected === undefined || selected === held) onSelect(next)
  })

  // A note opened from elsewhere scrolls into view; while the gallery has the
  // keyboard its card takes it. `navigated` is the card the gallery opened
  // itself, already focused: an older selection that lands after it must not
  // pull the keyboard back (quick arrow keys).
  const shownOpen = useRef(selected)
  const navigated = useRef<string>(undefined)
  useEffect(() => {
    if (shownOpen.current === selected) return
    shownOpen.current = selected
    if (navigated.current !== undefined) {
      if (navigated.current === selected) navigated.current = undefined
      return
    }
    if (selected === undefined || !indexOf.has(selected)) return
    reveal(indexOf.get(selected)!)
    const active = document.activeElement
    const card = cards.current.get(selected)
    if (card && active && active !== card && list.current?.contains(active) && !chosen) {
      card.focus({ preventScroll: true })
    }
  })

  const open = (id: string) => {
    if (id !== selected || navigated.current !== undefined) navigated.current = id
    focusCard(id)
    onSelect(id)
  }

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

  /** Home, End, Page Up and Page Down, and the arrows across the grid, from the card at `at`. */
  const moveKey = (event: KeyboardEvent, at: number): boolean => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 0) / rowStep)) * columns
    const rtl = list.current ? getComputedStyle(list.current).direction === 'rtl' : false
    const to =
      jumpIndex(event.key, at, order.length, page) ??
      (at < 0 ? undefined : galleryStep(at, order.length, columns, event.key, rtl))
    const id = to === undefined ? undefined : order[to]
    if (id === undefined) return false
    event.preventDefault()
    open(id)
    return true
  }

  const cardKey = useStable((id: string, event: KeyboardEvent<HTMLLIElement>) => {
    if (heldCommandKey(event)) {
      event.preventDefault()
      return
    }
    if (selectionKey(event)) return
    const target = keyTarget(selection, selected, id) ?? id
    if (props.onMenu && commandMatches('list.rowMenu', event)) {
      event.preventDefault()
      const box = cards.current.get(id)?.getBoundingClientRect()
      return props.onMenu(target, box ? { x: box.left, y: box.bottom } : undefined)
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
    moveKey(event, indexOf.get(id) ?? -1)
  })

  /** Keys on the grid itself, which has the keyboard while no card does: an arrow opens the first card. */
  const gridKey = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.target !== event.currentTarget) return
    if (heldCommandKey(event)) {
      event.preventDefault()
      return
    }
    if (selectionKey(event)) return
    if (props.onFind && commandMatches('search.fromList', event)) {
      event.preventDefault()
      return props.onFind()
    }
    const at = selected === undefined ? -1 : (indexOf.get(selected) ?? -1)
    if (moveKey(event, at)) return
    const first = order[0]
    if (first === undefined || !event.key.startsWith('Arrow')) return
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    open(at >= 0 ? order[at]! : first)
  }

  const click = useStable((id: string, event: MouseEvent<HTMLLIElement>) => {
    const gesture = event.metaKey ? selectToggle : event.shiftKey ? selectRange : undefined
    if (!gesture) return open(id)
    event.currentTarget.focus()
    onSelection(gesture(selection, selected, id, order))
  })

  const [dragged, setDragged] = useState<ReadonlySet<string>>()
  useEffect(() => {
    if (!dragged) return
    const end = () => setDragged(undefined)
    window.addEventListener('dragend', end, true)
    window.addEventListener('drop', end, true)
    return () => {
      window.removeEventListener('dragend', end, true)
      window.removeEventListener('drop', end, true)
    }
  }, [dragged])
  const byId = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes])
  const dragStart = useStable((id: string, event: DragEvent<HTMLLIElement>) => {
    const picked = idsFor(id).map((noteId) => ({
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
    setDragged(new Set(picked.map((n) => n.id)))
  })
  const contextMenu = useStable((id: string, event: MouseEvent<HTMLLIElement>) => {
    event.preventDefault()
    props.onMenu?.(id)
  })
  const setCard = useStable((id: string, el: HTMLLIElement) => {
    cards.current.set(id, el)
    return () => {
      if (cards.current.get(id) === el) cards.current.delete(id)
    }
  })
  const events = useMemo<CardEvents>(
    () => ({ setCard, click, dragStart, keyDown: cardKey, contextMenu }),
    [setCard, click, dragStart, cardKey, contextMenu],
  )

  const scale = galleryScale(cardWidth, PAGE_INSET, PAGE_WIDTH)

  return (
    <section
      className="list gallery"
      data-devot-part="list"
      aria-label={t('noteList.label')}
      style={{ '--list-width': `${width}px` } as CSSProperties}
    >
      <ListHeader
        title={props.title}
        scope={props.scope}
        count={notes.length}
        capped={props.capped}
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
          else list.current?.focus()
        }}
      />
      {emptyText ? (
        <div className="list-empty">
          <span className="list-empty-message">{t(emptyText.message)}</span>
          {emptyText.tip ? <span className="list-empty-tip">{t(emptyText.tip)}</span> : null}
        </div>
      ) : (
        <div ref={scroller} className="gallery-scroll" onScroll={measure}>
          <ul
            ref={gridRef}
            className="gallery-grid"
            role="listbox"
            aria-label={t('noteList.label')}
            aria-multiselectable
            tabIndex={-1}
            onKeyDown={gridKey}
            style={
              {
                height: rows > 0 ? rows * rowStep - GAP : 0,
                '--gallery-card-width': `${cardWidth}px`,
                '--gallery-card-height': `${cardHeight}px`,
                '--gallery-scale': scale,
              } as CSSProperties
            }
          >
            {cardWidth > 0
              ? shown.map((index) => {
                  const note = notes[index]!
                  const { row, column } = galleryPlace(index, columns)
                  return (
                    <GalleryCard
                      key={note.id}
                      note={note}
                      start={column * (cardWidth + GAP)}
                      top={row * rowStep}
                      position={index + 1}
                      setSize={notes.length}
                      selected={
                        chosen ? chosen.has(note.id) : note.id === (props.opening ?? selected)
                      }
                      tabbable={note.id === tabStop}
                      tags={props.tags}
                      changedBy={props.changedBy?.get(note.id)}
                      headline={headlines.get(note.id)}
                      tasks={taskCounts.get(note.id)}
                      preview={previews.get(note.id)}
                      draggable={props.draggable}
                      dragging={dragged?.has(note.id) ?? false}
                      menu={props.onMenu !== undefined}
                      now={now}
                      locale={locale}
                      dates={dates}
                      events={events}
                    />
                  )
                })
              : null}
          </ul>
        </div>
      )}
      <div className="list-resize" aria-label={t('gallery.resize')} {...edge} />
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
  start: number
  top: number
  position: number
  setSize: number
  selected: boolean
  tabbable: boolean
  tags: ReadonlyMap<string, TagRecord>
  changedBy: WriterRef | undefined
  headline: string | undefined
  tasks: TaskProgress | undefined
  preview: CardPreview | undefined
  draggable: boolean
  dragging: boolean
  menu: boolean
  now: number
  locale: string
  dates: ListDatesStyle
  events: CardEvents
}

export const GalleryCard = memo(function GalleryCard(props: CardProps) {
  const { note: n, events } = props
  const id = n.id
  const ref = useCallback((el: HTMLLIElement) => events.setCard(id, el), [events, id])
  const page = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (page.current) patchChildren(page.current, props.preview ?? [])
  }, [props.preview])
  return (
    <li
      ref={ref}
      className="gallery-card"
      data-note-id={id}
      role="option"
      aria-selected={props.selected}
      aria-posinset={props.position}
      aria-setsize={props.setSize}
      tabIndex={props.tabbable ? 0 : -1}
      style={{ insetInlineStart: props.start, top: props.top }}
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
      {/* The option is named by its content, as a board card is: the title, then the caption. */}
      <span className="visually-hidden">{displayTitle(n.title, props.headline)}</span>
      <div className="gallery-sheet" aria-hidden inert>
        <div className="gallery-thumb">
          {n.title || props.preview?.length === 0 ? (
            <div className="preview gallery-page">
              <h1 className={n.title ? 'note-title' : 'note-title is-untitled'} dir="auto">
                {n.title || t('note.untitled')}
              </h1>
            </div>
          ) : null}
          <div ref={page} className="preview gallery-page" />
        </div>
      </div>
      <span className="gallery-card-caption">
        <CardMeta
          note={n}
          tags={props.tags}
          now={props.now}
          locale={props.locale}
          dates={props.dates}
          changedBy={props.changedBy}
          tasks={props.tasks}
          marks
        />
      </span>
    </li>
  )
})
