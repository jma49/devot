import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react'
import type { NoteSummary, TagRecord } from '../../core'
import { noteCount } from './format'
import { currentLocale, format, t } from './i18n'
import { Icon } from './icons/Icon'
import type { IconName } from './icons/symbols'
import { commandMatches, heldCommandKey } from './commands/registry'
import {
  openAfter,
  selectAll,
  selectRange,
  selectStep,
  selectToggle,
  type ListSelection,
} from './listSelection'
import { useHeadlines, type HeadlineLoader } from './headlines'
import { dragCardLines, setDragCard } from './listDrag'
import { listEmpty, type ListEmptyKind } from './listEmpty'
import { LIST_MAX_WIDTH, LIST_MIN_WIDTH, clampListWidth, currentListWidthStore } from './listWidth'
import { entryOffsets, spacerHeight, windowRuns } from './listWindow'
import { noteShortcut, trashShortcut, type NoteAction, type TrashAction } from './noteMenu'
import { DRAG_NOTE, DRAG_TEMPLATE } from './Sidebar'
import { useStable } from './stable'
import { NoteRow, type RowEvents } from './NoteRow'
import { isImeKey } from './ime'

interface Props {
  /**
   * Which view the list shows (a library and filter, the Trash, search
   * results). Rows that leave the list within one view hand the keyboard on
   * to a neighbour; a new view starts afresh.
   */
  view: string
  /** The library shown: All Notes, a notebook, or the active filter. */
  title: string
  /** The notebook a filter is narrowed to, shown in the caption. */
  scope?: string | undefined
  /** Pinned notes, listed in their own section above `notes`. */
  pinned: NoteSummary[]
  notes: NoteSummary[]
  /** Tags by ID, for the chips on each row. */
  tags: ReadonlyMap<string, TagRecord>
  selected: string | undefined
  onSelect: (id: string) => void
  onCreate: (() => void) | undefined
  /** The create button's label (New Note by default; New Template in Templates). */
  createLabel?: string | undefined
  /** Replaces the New Note button (the Trash shows Empty Trash). */
  headerAction?: ReactNode
  /** Shown under the list, outside its scrolling (the Templates view's Built-in group). */
  after?: ReactNode
  /**
   * A note shortcut pressed in the list (see `noteShortcut`), for the selected
   * note; none in the Trash.
   */
  onAction?: (action: NoteAction, id: string) => void
  /** A Trash shortcut pressed in the Trash's list (see `trashShortcut`), for the selected note. */
  onTrashAction?: (action: TrashAction, id: string) => void
  /** Right-click on a row: show the note menu for it. */
  onMenu?: (id: string) => void
  /** The sort button: its tooltip (the current order) and what it opens. */
  sort?: { label: string; chip: string; onOpen: (anchor: HTMLElement) => void }
  /** The sort chip itself (the palette's Sort Notes… opens its pop-up there). */
  sortButtonRef?: Ref<HTMLButtonElement>
  /** `/` pressed on a row (`search.fromList`): search this view. */
  onFind?: () => void
  /**
   * Return (`note.editTitle`) or Cmd+Return (`note.editBody`) on a row: edit
   * the open note's title or body (the row's note when none is open).
   */
  onEdit?: (part: 'title' | 'body', id: string) => void
  /** The view's icon, shown beside its name in the header. */
  icon?: IconName | undefined
  /** The Filter field under the header (the search field; none in the Trash). */
  filter?: ReactNode
  /** Shown first in the toolbar (Show Sidebar while the sidebar is hidden). */
  leading?: ReactNode
  /** Search results: what to mark in titles and in body excerpts (see `searchPattern`). */
  highlight?: { title: RegExp | null; body: RegExp | null }
  /**
   * Several notes selected (see listSelection.ts); undefined while the open
   * note is the only one.
   */
  selection?: ListSelection | undefined
  /**
   * The selection changed: Cmd-click, Shift-click, Shift+Up or Shift+Down,
   * Select All (Cmd+A), or Escape (undefined: the open note alone). Without
   * it the list selects one note at a time.
   */
  onSelection?: (next: ListSelection | undefined) => void
  /**
   * What a row's drag carries: notes (the default), templates (which a
   * status or tag row does not take), or nothing (the Trash's rows stay put).
   */
  drag?: 'notes' | 'templates' | false
  /**
   * Looks up what a row shows for a note with no title: its first line.
   * Without it such a row shows "Untitled".
   */
  headlines?: HeadlineLoader | undefined
  /** Looks up the body excerpt a row shows under its title (search results bring their own). */
  excerpts?: HeadlineLoader | undefined
  /** Looks up each note's task progress, "done/total" (see NoteService.progress). */
  progress?: HeadlineLoader | undefined
  /** What the list says when it has no rows (see listEmpty.ts). */
  empty?: ListEmptyKind | undefined
}

const MINUTE = 60_000

/**
 * Lists longer than this render only the rows near the part that shows
 * (see listWindow.ts): with thousands of rows in the page, every change
 * anywhere in the window costs the browser more.
 */
const WINDOW_FROM = 200
/** Rows rendered beyond each edge of the part that shows, in pixels. */
const OVERSCAN_PX = 600
/** Entries rendered before any has been measured. */
const FIRST_ENTRIES = 50

/** A row or a section header of the list. */
type Entry =
  | { kind: 'section'; key: string; section: 'pinned' | 'others' }
  | { kind: 'row'; key: string; note: NoteSummary; index: number }

/** The current time, refreshed every minute so relative times stay right. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** Stands for entries of a windowed list that are not rendered. */
function spacer(key: string, height: number) {
  return <li key={key} className="rows-spacer" role="presentation" style={{ height }} />
}

/**
 * The middle pane: a toolbar and the notes, navigable with the arrow keys.
 * It renders again only when its props change (its owner keeps them the
 * same while nothing it shows changes), and then only the rows that changed.
 */
export const NoteList = memo(function NoteList(props: Props) {
  const { title, scope, pinned, selected, onSelect, onCreate, tags, sortButtonRef } = props
  // Keyboard order: the pinned section, then the rest.
  const notes = useMemo(() => [...pinned, ...props.notes], [pinned, props.notes])
  const order = useMemo(() => notes.map((n) => n.id), [notes])
  const { selection, onSelection } = props
  const chosen = selection ? new Set(selection.ids) : undefined
  // The row that takes Tab: the far end of a selection, else the open note's,
  // else the first row (the open note may not be listed: another notebook, a
  // filter): the list always keeps a Tab stop.
  const tabStop =
    selection && order.includes(selection.lead)
      ? selection.lead
      : selected !== undefined && order.includes(selected)
        ? selected
        : order[0]
  const rows = useRef(new Map<string, HTMLLIElement>())
  const list = useRef<HTMLUListElement>(null)
  const now = useNow()
  const locale = currentLocale()

  // The width the user dragged the right edge to, saved when the drag ends.
  const [width, setWidth] = useState(() => currentListWidthStore().read())
  const resizing = useRef<{ x: number; width: number } | null>(null)
  const resizeStart = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizing.current = { x: e.clientX, width }
  }
  const resizeMove = (e: PointerEvent<HTMLDivElement>) => {
    const from = resizing.current
    if (from) setWidth(clampListWidth(from.width + e.clientX - from.x))
  }
  const resizeEnd = (e: PointerEvent<HTMLDivElement>) => {
    const from = resizing.current
    if (!from) return
    resizing.current = null
    const next = clampListWidth(from.width + e.clientX - from.x)
    setWidth(next)
    currentListWidthStore().write(next)
  }

  // A long list renders only the entries near the part that shows (see
  // WINDOW_FROM), placed by their measured heights; the open note's row, the
  // focused row, the row that takes Tab and their neighbours always render,
  // so the keyboard never loses its row and the arrow keys find the next.
  const windowed = notes.length > WINDOW_FROM
  const entries = useMemo(() => {
    const out: Entry[] = []
    if (pinned.length > 0) out.push({ kind: 'section', key: 'section:pinned', section: 'pinned' })
    notes.forEach((note, index) => {
      if (pinned.length > 0 && index === pinned.length) {
        out.push({ kind: 'section', key: 'section:others', section: 'others' })
      }
      out.push({ kind: 'row', key: note.id, note, index })
    })
    return out
  }, [notes, pinned.length])
  // The row with the keyboard focus, which a windowed list keeps rendered.
  const [focusedRow, setFocusedRow] = useState<string>()
  // The rows being dragged, dimmed until the drag ends (dropped or not).
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
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [metrics, setMetrics] = useState({ gap: 0, padding: 0 })
  const [viewport, setViewport] = useState({ top: 0, height: 0 })
  // A row the keyboard is sent to before it is rendered: rendered, then focused.
  const [revealed, setRevealed] = useState<string>()
  const toFocus = useRef<string>(undefined)
  const offsets = useMemo(() => {
    if (!windowed) return undefined
    let sum = 0
    for (const h of heights.values()) sum += h
    const estimate = heights.size > 0 ? sum / heights.size : 0
    return entryOffsets(
      entries.map((e) => heights.get(e.key) ?? estimate),
      metrics.gap,
    )
  }, [windowed, entries, heights, metrics.gap])
  const entryAt = useMemo(() => new Map(entries.map((e, i) => [e.key, i])), [entries])
  const runs = useMemo((): [number, number][] => {
    if (!offsets) return [[0, entries.length]]
    const kept: number[] = []
    for (const id of [selected, tabStop ?? order[0], focusedRow, revealed]) {
      const i = id === undefined ? undefined : entryAt.get(id)
      if (i === undefined) continue
      // The neighbours in keyboard order, across a section header.
      kept.push(i - 2, i - 1, i, i + 1, i + 2)
    }
    // Nothing measured yet: the first entries, to measure.
    if (heights.size === 0 || viewport.height === 0) {
      for (let i = 0; i < Math.min(entries.length, FIRST_ENTRIES); i += 1) kept.push(i)
      return windowRuns(offsets, metrics.gap, null, 0, kept)
    }
    const top = viewport.top - metrics.padding
    return windowRuns(offsets, metrics.gap, { top, height: viewport.height }, OVERSCAN_PX, kept)
  }, [
    offsets,
    entries,
    entryAt,
    selected,
    tabStop,
    order,
    focusedRow,
    revealed,
    heights.size,
    viewport,
    metrics,
  ])
  // The rows that render look up what they show for a note with no title.
  const rendered = useMemo(
    () =>
      runs.flatMap(([start, end]) =>
        entries.slice(start, end).flatMap((e) => (e.kind === 'row' ? [e.note] : [])),
      ),
    [runs, entries],
  )
  const headlines = useHeadlines(props.headlines, rendered)
  const previews = useHeadlines(props.excerpts, rendered, true)
  const progress = useHeadlines(props.progress, rendered, true)
  // A long list measures its entries as they render and change size, and
  // itself (its gaps, padding and height), and renders again when that
  // moves anything.
  const [sizes] = useState(
    () =>
      new ResizeObserver((changes) => {
        const measured = new Map<string, number>()
        for (const change of changes) {
          const el = change.target as HTMLElement
          if (el instanceof HTMLUListElement) {
            const style = getComputedStyle(el)
            const gap = parseFloat(style.rowGap) || 0
            const padding = parseFloat(style.paddingTop) || 0
            setMetrics((m) => (m.gap === gap && m.padding === padding ? m : { gap, padding }))
            setViewport((v) =>
              v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight },
            )
            continue
          }
          const key = el.dataset['noteId'] ?? el.dataset['section']
          if (key !== undefined) measured.set(key, el.getBoundingClientRect().height)
        }
        if (measured.size === 0) return
        setHeights((known) => {
          let next: Map<string, number> | undefined
          for (const [key, height] of measured) {
            if (known.get(key) === height) continue
            next ??= new Map(known)
            next.set(key, height)
          }
          return next ?? known
        })
      }),
  )
  // Rows and section headers rendered later are observed as they come (see
  // `setRow`, `observeSection`).
  useEffect(() => {
    const el = list.current
    if (!windowed || !el) return
    sizes.observe(el)
    for (const child of el.children) {
      if (child instanceof HTMLElement && (child.dataset['noteId'] ?? child.dataset['section'])) {
        sizes.observe(child)
      }
    }
    return () => sizes.disconnect()
  }, [windowed, sizes])
  const observeSection = useStable((el: HTMLLIElement | null) => {
    if (!el || !windowed) return
    sizes.observe(el)
    return () => sizes.unobserve(el)
  })
  /** Gives the keyboard to a row, rendering it first when the list is windowed. */
  const focusRow = (id: string) => {
    const row = rows.current.get(id)
    if (row) return row.focus()
    toFocus.current = id
    setRevealed(id)
  }
  // After every render: the row may have just been rendered.
  useEffect(() => {
    const id = toFocus.current
    const row = id === undefined ? undefined : rows.current.get(id)
    if (!row) return
    toFocus.current = undefined
    row.scrollIntoView({ block: 'nearest' })
    row.focus()
  })

  // A selection made elsewhere (a new note, a duplicate) is scrolled into
  // view: the order may put it anywhere, even below the fold. While the list
  // has the keyboard it also takes the focus, so the next key acts on that
  // note. A selection the list made itself (arrow keys, a click) is already
  // focused, and an older one that lands late must not pull the focus back.
  // `navigated` is the row the list moved to that the selection has not
  // caught up with; `follow` is the row to show once it is rendered (search
  // results arrive later).
  // `openedBySelection` is a note a selection change opened (see `changeSelection`):
  // its row is not where the gesture put the keyboard, so it is not followed.
  const navigated = useRef<string>(undefined)
  const openedBySelection = useRef<string>(undefined)
  const follow = useRef<string>(undefined)
  useEffect(() => {
    const arrived = navigated.current === selected
    const opened = arrived && openedBySelection.current === selected
    if (arrived) {
      navigated.current = undefined
      openedBySelection.current = undefined
    }
    follow.current = navigated.current === undefined && !opened ? selected : undefined
  }, [selected])
  // After every render: the row may have just appeared.
  useEffect(() => {
    const row = follow.current ? rows.current.get(follow.current) : undefined
    if (!row) return
    follow.current = undefined
    row.scrollIntoView({ block: 'nearest' })
    if (list.current?.contains(document.activeElement)) row.focus()
  })

  /** The list moves the keyboard itself; `onSelect` follows. */
  const navigate = (id: string) => {
    // Back on the selected row with nothing pending: no selection change comes.
    if (id !== selected || navigated.current !== undefined) navigated.current = id
    openedBySelection.current = undefined
    follow.current = undefined
    onSelect(id)
  }

  // The row that has the keyboard, remembered until the keyboard goes
  // somewhere else on purpose, and the rows of the last render. When that
  // row leaves the list within one view (Move to Trash, Delete Permanently,
  // a move out of the notebook, a change the filter hides) the keyboard would
  // fall to the page: the open note's row takes it if it is still listed;
  // else the next row (or the previous one at the end) takes it, and opens
  // unless another note is open; else the list itself.
  const keyboard = useRef<string>(undefined)
  const shown = useRef<{ view: string; notes: NoteSummary[] }>({
    view: props.view,
    notes: [],
  })
  // Native listeners: React ignores focus changes made while it commits, such
  // as a closing dialog giving the keyboard back to its row.
  useEffect(() => {
    const el = list.current
    if (!el) return
    const onFocusIn = (e: FocusEvent) => {
      const id = e.target instanceof HTMLElement ? e.target.dataset['noteId'] : undefined
      if (id !== undefined) keyboard.current = id
      setFocusedRow(id)
      // The row asked for has the keyboard now; it stays rendered as the focused row.
      setRevealed(undefined)
    }
    // Focus that moves on, or falls to the page while its row stays (a click
    // on a button that takes no focus, or on blank space), leaves the list
    // for good. A row that is removed takes the focus with it: handled below.
    const onFocusOut = (e: FocusEvent) => {
      const from = e.target
      const to = e.relatedTarget
      if (to instanceof Node) {
        if (!el.contains(to)) {
          keyboard.current = undefined
          setFocusedRow(undefined)
        }
        return
      }
      queueMicrotask(() => {
        const active = document.activeElement
        const away = !active || active === document.body
        if (away && from instanceof Node && from.isConnected) {
          keyboard.current = undefined
          setFocusedRow(undefined)
        }
      })
    }
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', onFocusOut)
    return () => {
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('focusout', onFocusOut)
    }
  }, [])
  useEffect(() => {
    const before = shown.current
    shown.current = { view: props.view, notes }
    const lost = keyboard.current
    if (lost === undefined || notes.some((n) => n.id === lost)) return
    keyboard.current = undefined
    // Another view (the Trash, another notebook, another search) is not a
    // row leaving.
    if (before.view !== props.view) return
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    const listed = new Set(notes.map((n) => n.id))
    if (selected !== undefined && selected !== lost && listed.has(selected)) {
      return focusRow(selected)
    }
    const ids = before.notes.map((n) => n.id)
    const at = ids.indexOf(lost)
    const kept = (id: string) => listed.has(id)
    const next = ids.slice(at + 1).find(kept) ?? ids.slice(0, Math.max(at, 0)).findLast(kept)
    if (next === undefined) return list.current?.focus()
    focusRow(next)
    // The open note stays open when it is not the one that left (a filter
    // may hide it); the keys still act on it, as for any focused row.
    if (selected === undefined || selected === lost) navigate(next)
  })

  /**
   * A new selection from a gesture or key in the list. The note it leaves
   * open (see `openAfter`) is opened by the owner; the list keeps the
   * keyboard where the gesture put it.
   */
  const changeSelection = (next: ListSelection | undefined) => {
    if (!onSelection) return
    const open =
      next === undefined ? undefined : next.ids.length > 1 ? openAfter(next, selected) : next.ids[0]
    const opens = open !== undefined && open !== selected ? open : undefined
    if (opens !== undefined) navigated.current = opens
    // With several rows selected the keyboard stays on the gesture's row; one
    // row left is the open note's, and it takes the keyboard.
    openedBySelection.current = next && next.ids.length > 1 ? opens : undefined
    follow.current = undefined
    onSelection(next)
  }

  /**
   * A held command key (Cmd+A, Cmd+C, ...) does nothing after its first press,
   * and is stopped so it does not repeat into the menu bar; whether it was one.
   */
  const heldKey = (event: KeyboardEvent): boolean => {
    if (!heldCommandKey(event)) return false
    event.preventDefault()
    return true
  }

  /** Cmd+A, Escape, Shift+Up and Shift+Down; whether the key was one of them. */
  const selectionKey = (event: KeyboardEvent): boolean => {
    if (!onSelection) return false
    if (commandMatches('list.selectAll', event)) {
      event.preventDefault()
      const next = selectAll(selection, selected, order)
      if (next) changeSelection(next)
      return true
    }
    if (selection && commandMatches('list.clearSelection', event)) {
      event.preventDefault()
      changeSelection(undefined)
      if (selected !== undefined) focusRow(selected)
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
    focusRow(next.lead)
    changeSelection(next)
    return true
  }

  /** Keys on the list itself (it holds the keyboard when it is empty or clicked). */
  const listKey = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return
    if (heldKey(event)) return
    if (selectionKey(event)) return
    if (props.onFind && commandMatches('search.fromList', event)) {
      event.preventDefault()
      return props.onFind()
    }
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    const to =
      (selected !== undefined && order.includes(selected) ? selected : undefined) ??
      notes[step < 0 ? notes.length - 1 : 0]?.id
    if (!step || to === undefined) return
    event.preventDefault()
    focusRow(to)
    navigate(to)
  }

  const move = (event: KeyboardEvent, index: number) => {
    if (heldKey(event)) return
    if (selectionKey(event)) return
    // Shortcuts act on the open note, even when another row has the focus
    // (a right-click focuses its row) or the open note is filtered out.
    // Every key here comes from the registry.
    const target = selected ?? notes[index]?.id
    const action = target && props.onAction ? noteShortcut(event) : undefined
    if (target && action) {
      event.preventDefault()
      return props.onAction?.(action, target)
    }
    const trashAction = target && props.onTrashAction ? trashShortcut(event) : undefined
    if (target && trashAction) {
      event.preventDefault()
      return props.onTrashAction?.(trashAction, target)
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
    if (target && part && props.onEdit) {
      event.preventDefault()
      return props.onEdit(part, target)
    }
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    const next = notes[index + step]
    if (!step || !next) return
    event.preventDefault()
    focusRow(next.id)
    navigate(next.id)
  }

  // The rows' events, the same functions for every render (see NoteRow).
  const setRow = useStable((id: string, el: HTMLLIElement | null) => {
    if (el) {
      rows.current.set(id, el)
      if (windowed) sizes.observe(el)
      return
    }
    const gone = rows.current.get(id)
    if (gone) sizes.unobserve(gone)
    rows.current.delete(id)
  })
  const mouseDown = useStable((e: MouseEvent<HTMLLIElement>) => {
    // Shift-click selects rows, not the text between them.
    if (onSelection && e.shiftKey) e.preventDefault()
  })
  const click = useStable((id: string, e: MouseEvent<HTMLLIElement>) => {
    // Cmd-click adds or takes out a row, Shift-click selects a range.
    const gesture =
      onSelection && e.metaKey ? selectToggle : onSelection && e.shiftKey ? selectRange : undefined
    if (!gesture) return navigate(id)
    e.currentTarget.focus()
    changeSelection(gesture(selection, selected, id, order))
  })
  const dragStart = useStable((id: string, e: DragEvent<HTMLLIElement>) => {
    // A selected row takes the whole selection with it.
    const ids = chosen?.has(id) ? (selection?.ids ?? [id]) : [id]
    e.dataTransfer.setData(DRAG_NOTE, ids.join('\n'))
    if (props.drag === 'templates') e.dataTransfer.setData(DRAG_TEMPLATE, '')
    e.dataTransfer.effectAllowed = 'move'
    const byId = new Map(notes.map((n) => [n.id, n]))
    const titles = ids.map(
      (noteId) => byId.get(noteId)?.title || headlines.get(noteId) || t('note.untitled'),
    )
    setDragCard(e.dataTransfer, dragCardLines(titles, locale))
    setDragged(new Set(ids))
  })
  const keyDown = useStable((id: string, e: KeyboardEvent<HTMLLIElement>) =>
    move(e, order.indexOf(id)),
  )
  const contextMenu = useStable((id: string, e: MouseEvent<HTMLLIElement>) => {
    e.preventDefault()
    props.onMenu?.(id)
  })
  const rowEvents = useMemo<RowEvents>(
    () => ({ setRow, mouseDown, click, dragStart, keyDown, contextMenu }),
    [setRow, mouseDown, click, dragStart, keyDown, contextMenu],
  )

  const renderEntry = (entry: Entry) => {
    if (entry.kind === 'section') {
      return (
        <li
          key={entry.key}
          ref={observeSection}
          className="list-section"
          role="presentation"
          data-section={entry.key}
        >
          {entry.section === 'pinned' ? <Icon name="notes.pinned" size="sm" /> : null}
          {t(entry.section === 'pinned' ? 'noteList.pinned' : 'noteList.others')}
        </li>
      )
    }
    const n = entry.note
    return (
      <NoteRow
        key={n.id}
        note={n}
        position={windowed ? entry.index + 1 : undefined}
        setSize={windowed ? notes.length : undefined}
        selected={chosen ? chosen.has(n.id) : n.id === selected}
        open={n.id === selected}
        tabbable={n.id === tabStop || (!tabStop && entry.index === 0)}
        tags={tags}
        highlight={props.highlight}
        headline={headlines.get(n.id)}
        preview={previews.get(n.id)}
        progress={progress.get(n.id)}
        now={now}
        locale={locale}
        draggable={props.drag !== false}
        dragging={dragged?.has(n.id) ?? false}
        menu={props.onMenu !== undefined}
        events={rowEvents}
      />
    )
  }

  const caption = scope
    ? format(t('noteList.scopedCount'), {
        scope,
        notes: noteCount(notes.length, currentLocale()),
      })
    : noteCount(notes.length, currentLocale())

  return (
    <section
      className="list"
      data-devot-part="list"
      aria-label={t('noteList.label')}
      style={{ '--list-width': `${width}px` } as CSSProperties}
    >
      <div
        className="toolbar list-header"
        data-devot-part="toolbar"
        role="toolbar"
        aria-label={t('toolbar.label')}
        data-tauri-drag-region
      >
        <div className="list-header-side" data-tauri-drag-region>
          {props.leading}
        </div>
        <div className="toolbar-title" data-tauri-drag-region>
          <span className="headline-row" data-tauri-drag-region>
            {props.icon ? <Icon name={props.icon} size="sm" /> : null}
            {/* Long names are cut off with an ellipsis; the tooltip has the whole one. */}
            <span className="headline" title={title} data-tauri-drag-region>
              {title}
            </span>
          </span>
          <span className="caption" title={scope ? caption : undefined} data-tauri-drag-region>
            {caption}
          </span>
        </div>
        <div className="list-header-side list-header-end" data-tauri-drag-region>
          {props.headerAction ?? (
            <button
              type="button"
              className="tool"
              aria-label={props.createLabel ?? t('noteList.newNote')}
              title={props.createLabel ?? t('noteList.newNote')}
              onClick={onCreate}
              disabled={!onCreate}
            >
              <Icon name="note.new" size="md" />
            </button>
          )}
        </div>
      </div>
      {props.filter || props.sort ? (
        <div
          className="list-filter"
          onKeyDown={(e) => {
            // Return in the Filter field hands the keyboard to the list (not
            // the Return that picks a candidate of an input method).
            if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return
            if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isImeKey(e.nativeEvent)) return
            e.preventDefault()
            if (tabStop !== undefined) focusRow(tabStop)
            else list.current?.focus()
          }}
        >
          {props.filter}
          {props.sort ? (
            <button
              ref={sortButtonRef}
              type="button"
              className="sort-chip"
              aria-label={t('sort.button')}
              title={props.sort.label}
              onClick={(e) => props.sort?.onOpen(e.currentTarget)}
            >
              {props.sort.chip}
            </button>
          ) : null}
        </div>
      ) : null}
      <ul
        ref={list}
        className="rows"
        role="listbox"
        aria-label={t('noteList.label')}
        aria-multiselectable={onSelection ? true : undefined}
        // Not a tab stop (a row is), but it can hold the keyboard.
        tabIndex={-1}
        onKeyDown={listKey}
        onScroll={
          windowed
            ? (e) =>
                setViewport({
                  top: e.currentTarget.scrollTop,
                  height: e.currentTarget.clientHeight,
                })
            : undefined
        }
      >
        {/* One flat, keyed list: a row moving between sections keeps its element (and focus). */}
        {runs.flatMap(([start, end], r) => {
          const before = r === 0 ? 0 : runs[r - 1]![1]
          const out: ReactNode[] = []
          if (offsets && start > before) {
            out.push(spacer(`spacer:${before}`, spacerHeight(offsets, before, start, metrics.gap)))
          }
          for (let i = start; i < end; i += 1) out.push(renderEntry(entries[i]!))
          const after = runs[r + 1]?.[0] ?? entries.length
          if (offsets && r === runs.length - 1 && after > end) {
            out.push(spacer(`spacer:${end}`, spacerHeight(offsets, end, after, metrics.gap)))
          }
          return out
        })}
        {entries.length === 0 && props.empty ? <EmptyList kind={props.empty} /> : null}
      </ul>
      {props.after}
      <div
        className="list-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('noteList.resize')}
        aria-valuenow={width}
        aria-valuemin={LIST_MIN_WIDTH}
        aria-valuemax={LIST_MAX_WIDTH}
        onPointerDown={resizeStart}
        onPointerMove={resizeMove}
        onPointerUp={resizeEnd}
        onPointerCancel={resizeEnd}
      />
    </section>
  )
})

/** The empty list's message, and a tip for some views. */
function EmptyList({ kind }: { kind: ListEmptyKind }) {
  const { message, tip } = listEmpty(kind)
  return (
    <li className="list-empty" role="presentation">
      <span className="list-empty-message">{t(message)}</span>
      {tip ? <span className="list-empty-tip">{t(tip)}</span> : null}
    </li>
  )
}
