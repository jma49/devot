import {
  memo,
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
import type { NoteSummary, RowDetail, TagRecord } from '../../core'
import type { StripDay } from '../../core/activity'
import { withStrips, type RowInfo } from './ActivityStrip'
import { currentLocale, t } from './i18n'
import { Icon } from './icons/Icon'
import type { MenuPoint } from './contextMenu'
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
import { usePaneResize } from './paneResize'
import { LIST_PANE } from './paneWidth'
import { entryOffsets, spacerHeight, windowRuns } from './listWindow'
import { noteShortcut, trashShortcut, type NoteAction, type TrashAction } from './noteMenu'
import { DRAG_TEMPLATE, setNoteDragData } from './dragData'
import { useStable } from './stable'
import { useEditorSetting } from './editorSettings'
import type { WriterRef } from './authorshipLabels'
import { NoteRow, type RowEvents } from './NoteRow'
import { useRowMotion } from './rowMotion'
import { scrollRowIntoView } from './listScroll'
import { ListHeader } from './ListHeader'

interface Props {
  /**
   * Which view the list shows (a library and filter, the Trash, search
   * results). Rows that leave the list within one view hand the keyboard on
   * to a neighbour; a new view starts afresh.
   */
  view: string
  title: string
  scope?: string | undefined
  pinned: NoteSummary[]
  notes: NoteSummary[]
  tags: ReadonlyMap<string, TagRecord>
  selected: string | undefined
  /** The note being opened, drawn as selected until it is. */
  opening?: string | undefined
  onSelect: (id: string) => void
  onCreate: (() => void) | undefined
  createLabel?: string | undefined
  headerAction?: ReactNode
  after?: ReactNode
  onAction?: (action: NoteAction, id: string) => void
  onTrashAction?: (action: TrashAction, id: string) => void
  onMenu?: (id: string, at?: MenuPoint) => void
  sort?: { label: string; chip: string; onOpen: (anchor: HTMLElement) => void }
  sortButtonRef?: Ref<HTMLButtonElement>
  /** The List / Board control, for the views that can show a board. */
  layout?: ReactNode
  onFind?: () => void
  onEdit?: (part: 'title' | 'body', id: string) => void
  icon?: ReactNode
  onTitleMenu?: ((at: MenuPoint) => void) | undefined
  filter?: ReactNode
  leading?: ReactNode
  highlight?: { title: RegExp | null; body: RegExp | null }
  selection?: ListSelection | undefined
  /** Cmd-click, Shift-click, Shift+Up/Down, Select All or Escape (undefined: the open note alone). Without it the list selects one note at a time. */
  onSelection?: (next: ListSelection | undefined) => void
  /** What a row's drag carries: notes (default), templates (a status or tag row does not take them), or nothing (Trash rows stay put). */
  drag?: 'notes' | 'templates' | false
  /** Looks up the first line a row shows for an untitled note; without it such a row shows "Untitled". */
  headlines?: HeadlineLoader | undefined
  /** Looks up the body excerpt (search results bring their own) and task progress a row shows under its title, in one read. */
  details?: HeadlineLoader<RowDetail> | undefined
  /** Looks up each row's activity strip; without it rows show none (Settings can hide them). */
  activity?: HeadlineLoader<StripDay[]> | undefined
  empty?: ListEmptyKind | undefined
  /** The notes agents changed since the owner last looked, with the newest writer (agentWrites.ts). */
  changedBy?: ReadonlyMap<string, WriterRef> | undefined
}

const MINUTE = 60_000

/** Lists longer than this render only the rows near the part that shows (listWindow.ts); with thousands of rows, every change anywhere in the window costs more. */
const WINDOW_FROM = 200
const OVERSCAN_PX = 600
const FIRST_ENTRIES = 50

type Entry =
  | { kind: 'section'; key: string; section: 'pinned' | 'others' }
  | { kind: 'row'; key: string; note: NoteSummary; index: number }

/** The current time, refreshed every minute so relative times stay right. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE)
    return () => clearInterval(timer)
  }, [])
  return now
}

function spacer(key: string, height: number) {
  return <li key={key} className="rows-spacer" role="presentation" style={{ height }} />
}

/** Renders again only when its props change (its owner keeps them the same while nothing it shows changes), and then only the rows that changed. */
export const NoteList = memo(function NoteList(props: Props) {
  const { title, scope, pinned, selected, onSelect, onCreate, tags, sortButtonRef } = props
  const notes = useMemo(() => [...pinned, ...props.notes], [pinned, props.notes])
  const order = useMemo(() => notes.map((n) => n.id), [notes])
  const indexOf = useMemo(() => new Map(order.map((id, i) => [id, i])), [order])
  const { selection, onSelection } = props
  const chosen = useMemo(() => (selection ? new Set(selection.ids) : undefined), [selection])
  // The row that takes Tab: the far end of a selection, else the open note's, else the first row, so the list always keeps a Tab stop.
  const tabStop =
    selection && indexOf.has(selection.lead)
      ? selection.lead
      : selected !== undefined && indexOf.has(selected)
        ? selected
        : order[0]
  const rows = useRef(new Map<string, HTMLLIElement>())
  const list = useRef<HTMLUListElement>(null)
  const listElement = () => list.current
  useRowMotion(listElement, 'data-note-id', order, props.view, 'grow')
  const now = useNow()
  const locale = currentLocale()
  const dates = useEditorSetting('listDates')

  const { width, edge } = usePaneResize(LIST_PANE)

  // Renders only entries near the visible part (WINDOW_FROM), placed by measured heights; the open note's row, the focused row, the Tab-stop row and their neighbours always render, so the keyboard never loses its row.
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
  const [focusedRow, setFocusedRow] = useState<string>()
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
  const rendered = useMemo(
    () =>
      runs.flatMap(([start, end]) =>
        entries.slice(start, end).flatMap((e) => (e.kind === 'row' ? [e.note] : [])),
      ),
    [runs, entries],
  )
  const headlines = useHeadlines(props.headlines, rendered)
  const rowInfo = useMemo(
    () => withStrips(props.details, props.activity),
    [props.details, props.activity],
  )
  const details = useHeadlines<RowInfo>(rowInfo, rendered, true)
  // Measures its entries and the list itself (gaps, padding, height) as they change, and renders again when that moves anything.
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
  const focusRow = (id: string) => {
    const row = rows.current.get(id)
    if (row) return row.focus()
    toFocus.current = id
    setRevealed(id)
  }
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
  const repeating = useRef(false)
  // A selection the list asked for that no render has shown yet: a key or click before that render
  // builds on it, or quick Shift+Down presses would each extend the same old selection.
  const asked = useRef<{ selection: ListSelection | undefined }>(undefined)
  useEffect(() => {
    asked.current = undefined
  })
  const latest = () => ({
    selection: asked.current ? asked.current.selection : selection,
    selected: navigated.current ?? selected,
  })
  useEffect(() => {
    const arrived = navigated.current === selected
    const opened = arrived && openedBySelection.current === selected
    if (arrived) {
      navigated.current = undefined
      openedBySelection.current = undefined
    }
    follow.current = navigated.current === undefined && !opened ? selected : undefined
  }, [selected])
  useEffect(() => {
    const row = follow.current ? rows.current.get(follow.current) : undefined
    if (!row) return
    follow.current = undefined
    const behavior = scrollRowIntoView(row, repeating.current)
    if (list.current?.contains(document.activeElement))
      row.focus({ preventScroll: behavior === 'smooth' })
  })

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
  // unless another note is open; else the list itself. The hand-off runs in
  // the commit that removes the row (a layout effect): a passive effect may
  // run frames later on a loaded machine, after the window's focus rescue
  // (focusRescue.ts) has put the keyboard on another row, and the next row
  // would then not open.
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
  useLayoutEffect(() => {
    const before = shown.current
    shown.current = { view: props.view, notes }
    const lost = keyboard.current
    if (lost === undefined || indexOf.has(lost)) return
    keyboard.current = undefined
    // Another view (the Trash, another notebook, another search) is not a
    // row leaving.
    if (before.view !== props.view) return
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    if (selected !== undefined && selected !== lost && indexOf.has(selected)) {
      return focusRow(selected)
    }
    const ids = before.notes.map((n) => n.id)
    const at = ids.indexOf(lost)
    const kept = (id: string) => indexOf.has(id)
    const next = ids.slice(at + 1).find(kept) ?? ids.slice(0, Math.max(at, 0)).findLast(kept)
    if (next === undefined) return list.current?.focus()
    focusRow(next)
    // The open note stays open when it is not the one that left (a filter
    // may hide it); the keys still act on it, as for any focused row.
    if (selected === undefined || selected === lost) navigate(next)
  })

  /** A new selection from a gesture or key in the list; the owner opens the note it leaves open (`openAfter`), and the list keeps the keyboard where the gesture put it. */
  const changeSelection = (next: ListSelection | undefined) => {
    if (!onSelection) return
    const now = latest().selected
    const open =
      next === undefined ? undefined : next.ids.length > 1 ? openAfter(next, now) : next.ids[0]
    const opens = open !== undefined && open !== now ? open : undefined
    if (opens !== undefined) navigated.current = opens
    asked.current = { selection: next }
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

  const selectionKey = (event: KeyboardEvent): boolean => {
    if (!onSelection) return false
    const { selection, selected } = latest()
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
    focusRow(next.lead)
    changeSelection(next)
    return true
  }

  /** Opens a row's menu from the keyboard, under the row as a notebook row's menu opens. */
  const rowMenu = (id: string): boolean => {
    if (!props.onMenu) return false
    const box = rows.current.get(id)?.getBoundingClientRect()
    props.onMenu(id, box ? { x: box.left, y: box.bottom } : undefined)
    return true
  }

  const listKey = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return
    if (heldKey(event)) return
    if (selectionKey(event)) return
    if (
      selected !== undefined &&
      indexOf.has(selected) &&
      commandMatches('list.rowMenu', event) &&
      rowMenu(selected)
    ) {
      event.preventDefault()
      return
    }
    if (props.onFind && commandMatches('search.fromList', event)) {
      event.preventDefault()
      return props.onFind()
    }
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    // A bare arrow moves; with a modifier held it is another key (Shift+Down extends the selection).
    if (!step || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
    const to =
      (selected !== undefined && indexOf.has(selected) ? selected : undefined) ??
      notes[step < 0 ? notes.length - 1 : 0]?.id
    if (to === undefined) return
    event.preventDefault()
    focusRow(to)
    navigate(to)
  }

  const move = (event: KeyboardEvent, index: number) => {
    repeating.current = event.repeat
    if (heldKey(event)) return
    if (selectionKey(event)) return
    // Shortcuts act on the row that has the focus, never on an open note the
    // focus has left (a right-click focuses its row; a filter may hide the
    // open note). With several notes selected they act on the selection, whose
    // rows are all drawn selected. Every key here comes from the registry.
    const target = chosen ? (selected ?? notes[index]?.id) : notes[index]?.id
    if (target && commandMatches('list.rowMenu', event) && rowMenu(target)) {
      event.preventDefault()
      return
    }
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
    // A bare arrow moves; with a modifier held it is another key (Shift+Down extends the selection).
    if (!step || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
    const next = notes[index + step]
    if (!next) return
    event.preventDefault()
    focusRow(next.id)
    navigate(next.id)
  }

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
  // The row a press began on: pressing a row can reorder the list under the
  // pointer (the title field it leaves saves the open note's new title),
  // and the release then lands elsewhere; the press still opens its row.
  const pressed = useRef<string | undefined>(undefined)
  const mouseDown = useStable((e: MouseEvent<HTMLLIElement>) => {
    pressed.current = e.button === 0 ? e.currentTarget.dataset['noteId'] : undefined
    if (onSelection && e.shiftKey) e.preventDefault()
  })
  const click = useStable((id: string, e: MouseEvent<HTMLLIElement>) => {
    pressed.current = undefined
    const gesture =
      onSelection && e.metaKey ? selectToggle : onSelection && e.shiftKey ? selectRange : undefined
    if (!gesture) return navigate(id)
    e.currentTarget.focus()
    const now = latest()
    changeSelection(gesture(now.selection, now.selected, id, order))
  })
  const dragStart = useStable((id: string, e: DragEvent<HTMLLIElement>) => {
    const ids = chosen?.has(id) ? (selection?.ids ?? [id]) : [id]
    const byId = new Map(notes.map((n) => [n.id, n]))
    const picked = ids.map((noteId) => ({
      id: noteId,
      title: byId.get(noteId)?.title || headlines.get(noteId) || t('note.untitled'),
    }))
    setNoteDragData(e.dataTransfer, picked)
    if (props.drag === 'templates') e.dataTransfer.setData(DRAG_TEMPLATE, '')
    setDragCard(
      e.dataTransfer,
      dragCardLines(
        picked.map((n) => n.title),
        locale,
      ),
    )
    setDragged(new Set(ids))
  })
  const keyDown = useStable((id: string, e: KeyboardEvent<HTMLLIElement>) =>
    move(e, indexOf.get(id) ?? -1),
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
        selected={chosen ? chosen.has(n.id) : n.id === (props.opening ?? selected)}
        open={n.id === selected}
        tabbable={n.id === tabStop || (!tabStop && entry.index === 0)}
        tags={tags}
        highlight={props.highlight}
        changedBy={props.changedBy?.get(n.id)}
        headline={headlines.get(n.id)}
        preview={details.get(n.id)?.excerpt || undefined}
        progress={details.get(n.id)?.progress || undefined}
        strip={details.get(n.id)?.strip}
        now={now}
        locale={locale}
        dates={dates}
        draggable={props.drag !== false}
        dragging={dragged?.has(n.id) ?? false}
        menu={props.onMenu !== undefined}
        events={rowEvents}
      />
    )
  }

  return (
    <section
      className="list"
      data-devot-part="list"
      aria-label={t('noteList.label')}
      style={{ '--list-width': `${width}px` } as CSSProperties}
    >
      <ListHeader
        title={title}
        scope={scope}
        count={notes.length}
        icon={props.icon}
        onTitleMenu={props.onTitleMenu}
        leading={props.leading}
        headerAction={props.headerAction}
        onCreate={onCreate}
        createLabel={props.createLabel}
        filter={props.filter}
        sort={props.sort}
        sortButtonRef={sortButtonRef}
        layout={props.layout}
        onFilterDone={() => {
          if (tabStop !== undefined) focusRow(tabStop)
          else list.current?.focus()
        }}
      />
      <ul
        ref={list}
        className="rows"
        role="listbox"
        aria-label={t('noteList.label')}
        aria-multiselectable={onSelection ? true : undefined}
        // Not a tab stop (a row is), but it can hold the keyboard.
        tabIndex={-1}
        onKeyDown={listKey}
        onMouseUp={(e) => {
          // A press whose row moved away before the release (see `pressed`):
          // the release lands on another row or none, and no click follows.
          const id = pressed.current
          if (!id || e.button !== 0) return
          const on = (e.target as Element).closest<HTMLElement>('[data-note-id]')
          if (on?.dataset['noteId'] === id) return
          pressed.current = undefined
          const plain = !e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey
          if (plain) navigate(id)
        }}
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
      <div className="list-resize" aria-label={t('noteList.resize')} {...edge} />
    </section>
  )
})

function EmptyList({ kind }: { kind: ListEmptyKind }) {
  const { message, tip } = listEmpty(kind)
  return (
    <li className="list-empty" role="presentation">
      <span className="list-empty-message">{t(message)}</span>
      {tip ? <span className="list-empty-tip">{t(tip)}</span> : null}
    </li>
  )
}
