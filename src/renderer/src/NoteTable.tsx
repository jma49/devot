import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import type { NoteSummary, TagRecord } from '../../core'
import { errorCode } from '../../core/errors'
import {
  validPropertyKey,
  type Properties,
  type PropertyType,
  type PropertyValue,
} from '../../core/propertyTypes'
import { compareNames } from '../../core/sort'
import { commandMatches } from './commands/registry'
import { useContextMenu, type MenuGroups, type MenuPoint } from './contextMenu'
import { useEditorSetting } from './editorSettings'
import { localStore } from './localStore'
import { fullDate, rowDate } from './format'
import { displayTitle, useHeadlines, type HeadlineLoader } from './headlines'
import { currentLocale, format, t, type MessageKey } from './i18n'
import { Icon } from './icons/Icon'
import { listEmpty, type ListEmptyKind } from './listEmpty'
import { ListEmptyContent } from './ListEmptyContent'
import { ListHeader } from './ListHeader'
import { useNow } from './NoteList'
import { STATUS_ICONS } from './NoteRow'
import { usePaneResize } from './paneResize'
import { BOARD_PANE } from './paneWidth'
import { useStable } from './stable'
import {
  editText,
  parseCell,
  propertyColumnId,
  tableColumns,
  tableRows,
  tableSettingsStore,
  withFilter,
  type TableColumn,
  type TableFilter,
  type TableSettings,
} from './table'
import { sizes } from './theme/tokens'
import { useLocale } from './liveLocale'

export type PropertyLoader = (ids: string[]) => Promise<Record<string, Properties>>

export interface NoteTableProps {
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
  fittedWidth: number
  selected: string | undefined
  opening?: string | undefined
  onSelect: (id: string) => void
  onMenu?: (id: string, at?: MenuPoint) => void
  onFind?: () => void
  headlines?: HeadlineLoader | undefined
  properties: PropertyLoader | undefined
  /** Writes a cell; undefined while notes are read-only. */
  onWrite: ((id: string, key: string, value: PropertyValue) => Promise<void>) | undefined
  empty?: ListEmptyKind | undefined
  onSearchAll?: (() => void) | undefined
  editing?: boolean
  capped?: boolean | undefined
}

const px = (value: string) => Number.parseFloat(value)
const ROW_HEIGHT = px(sizes['size.table-row-height'])
const OVERSCAN_ROWS = 12
/** One storage read a batch, as many as one heads call takes. */
const BATCH = 500
const NO_PROPERTIES: Properties = {}

interface Cached {
  version: number
  properties: Properties
}

/**
 * The properties of `notes`, read in batches as their bodies change (`bodyVersion`). An answer is
 * kept for the version it was asked for, so one that lands after a newer save is read again.
 */
function useTableProperties(load: PropertyLoader | undefined, notes: readonly NoteSummary[]) {
  const [cache, setCache] = useState<ReadonlyMap<string, Cached>>(() => new Map())
  const latest = useRef(cache)
  useLayoutEffect(() => {
    latest.current = cache
  }, [cache])
  useEffect(() => {
    if (!load) return
    const wanted = notes.filter((n) => latest.current.get(n.id)?.version !== n.bodyVersion)
    if (wanted.length === 0) return
    const run = { live: true }
    void (async () => {
      for (let at = 0; at < wanted.length && run.live; at += BATCH) {
        const batch = wanted.slice(at, at + BATCH)
        let found: Record<string, Properties>
        try {
          found = await load(batch.map((n) => n.id))
        } catch (e) {
          console.warn('W_TABLE_PROPERTIES_FAILED', errorCode(e))
          return
        }
        if (!run.live) return
        setCache((was) => {
          const next = new Map(was)
          for (const n of batch) {
            next.set(n.id, { version: n.bodyVersion, properties: found[n.id] ?? NO_PROPERTIES })
          }
          if (next.size > notes.length * 2 + BATCH) {
            const listed = new Set(notes.map((n) => n.id))
            for (const id of next.keys()) if (!listed.has(id)) next.delete(id)
          }
          return next
        })
      }
    })()
    return () => {
      run.live = false
    }
  }, [load, notes])
  const properties = useMemo(
    () => new Map([...cache].map(([id, entry]) => [id, entry.properties])),
    [cache],
  )
  /** Shows a write at once; `undo` puts back what was there when the write fails. */
  const patch = useCallback((note: NoteSummary, key: string, value: PropertyValue) => {
    const before = latest.current.get(note.id)
    setCache((was) => {
      const next = new Map(was)
      const own = was.get(note.id)?.properties ?? NO_PROPERTIES
      next.set(note.id, { version: note.bodyVersion, properties: { ...own, [key]: value } })
      return next
    })
    return () =>
      setCache((was) => {
        const next = new Map(was)
        if (before) next.set(note.id, before)
        else next.delete(note.id)
        return next
      })
  }, [])
  return { properties, patch }
}

type MenuAction =
  | 'sortAscending'
  | 'sortDescending'
  | 'clearSort'
  | TableFilter
  | 'clearFilter'
  | 'hide'
  | 'showAll'

interface MenuTarget {
  column: TableColumn
  settings: TableSettings
}

const sortedAs = (target: MenuTarget, descending: boolean) =>
  target.settings.sort?.column === target.column.id &&
  target.settings.sort.descending === descending
const filteredAs = (target: MenuTarget, filter: TableFilter) =>
  target.settings.filters[target.column.id] === filter
const isCheckbox = (target: MenuTarget) =>
  'type' in target.column && target.column.type === 'checkbox'

const COLUMN_MENU: MenuGroups<MenuAction, MenuTarget> = [
  [
    {
      action: 'sortAscending',
      label: 'table.sortAscending',
      checked: (target) => sortedAs(target, false),
    },
    {
      action: 'sortDescending',
      label: 'table.sortDescending',
      checked: (target) => sortedAs(target, true),
    },
    {
      action: 'clearSort',
      label: 'table.clearSort',
      shown: (target) => target.settings.sort?.column === target.column.id,
    },
  ],
  [
    {
      action: 'filled',
      label: 'table.filterFilled',
      shown: (target) => !isCheckbox(target),
      checked: (target) => filteredAs(target, 'filled'),
    },
    {
      action: 'empty',
      label: 'table.filterEmpty',
      shown: (target) => !isCheckbox(target),
      checked: (target) => filteredAs(target, 'empty'),
    },
    {
      action: 'checked',
      label: 'table.filterChecked',
      shown: isCheckbox,
      checked: (target) => filteredAs(target, 'checked'),
    },
    {
      action: 'unchecked',
      label: 'table.filterUnchecked',
      shown: isCheckbox,
      checked: (target) => filteredAs(target, 'unchecked'),
    },
    {
      action: 'clearFilter',
      label: 'table.clearFilter',
      shown: (target) => target.settings.filters[target.column.id] !== undefined,
    },
  ],
  [
    {
      action: 'hide',
      label: 'table.hideColumn',
      shown: (target) => target.column.id !== 'field:title',
    },
    {
      action: 'showAll',
      label: 'table.showAllColumns',
      shown: (target) => target.settings.hidden.length > 0,
    },
  ],
]

const FIELD_LABELS: Readonly<Record<string, MessageKey>> = {
  'field:title': 'table.title',
  'field:status': 'table.status',
  'field:tags': 'table.tags',
  'field:updated': 'table.updated',
}

const columnName = (column: TableColumn) =>
  'field' in column ? t(FIELD_LABELS[column.id]!) : column.key

const typeLabel = (type: PropertyType) => t(`table.type.${type}`)

const writeMessage = (e: unknown): MessageKey =>
  errorCode(e) === 'E_FRONT_MATTER_INVALID' ? 'table.frontMatterInvalid' : 'table.writeFailed'

/** A YYYY-MM-DD date as the UI's locale writes it, read as a calendar day (no time zone). */
function dayText(value: string, locale: string): string {
  const [year, month, day] = value.split('-').map(Number)
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
      Date.UTC(year!, month! - 1, day!),
    )
  } catch {
    return value
  }
}

interface Cell {
  row: number
  column: number
}

interface Editing {
  id: string
  key: string
  type: PropertyType
  text: string
}

/**
 * The view's notes as a table: the note fields, then a column for each front matter property they
 * hold, typed by its values. A column's header sorts and filters; a property cell edits in place and
 * writes the note's front matter. Only the rows near the part that shows render.
 */
export const NoteTable = memo(function NoteTable(props: NoteTableProps) {
  useLocale()
  const { notes, selected, onSelect, onWrite } = props
  const locale = currentLocale()
  const collator = useMemo(
    () => ({ compare: (a: string, b: string) => compareNames(a, b, locale) }),
    [locale],
  )
  const store = useMemo(() => tableSettingsStore(localStore()), [])
  const [settingsOf, setSettingsOf] = useState(() => ({
    view: props.view,
    settings: store.load(props.view),
  }))
  const settings = settingsOf.view === props.view ? settingsOf.settings : store.load(props.view)
  const changeSettings = useStable((next: TableSettings) => {
    store.save(props.view, next)
    setSettingsOf({ view: props.view, settings: next })
  })
  const { properties, patch } = useTableProperties(props.properties, notes)
  const tagNames = useCallback(
    (note: NoteSummary) =>
      note.tagIds
        .flatMap((id) => {
          const name = props.tags.get(id)?.name
          return name === undefined ? [] : [name]
        })
        .sort((a, b) => compareNames(a, b, locale)),
    [props.tags, locale],
  )
  const columns = useMemo(
    () => tableColumns(notes, properties, settings, collator),
    [notes, properties, settings, collator],
  )
  const rows = useMemo(
    () => tableRows(notes, columns, properties, settings, tagNames, collator),
    [notes, columns, properties, settings, tagNames, collator],
  )
  const now = useNow()
  const dates = useEditorSetting('listDates')
  const { width, edge } = usePaneResize(BOARD_PANE, props.fittedWidth)

  const scroller = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, height: 0 })
  const measure = useStable(() => {
    const el = scroller.current
    if (!el) return
    const next = { top: el.scrollTop, height: el.clientHeight }
    setView((was) => (was.top === next.top && was.height === next.height ? was : next))
  })
  const observeScroller = useCallback(
    (el: HTMLDivElement | null) => {
      scroller.current = el
      if (!el) return
      const resized = new ResizeObserver(() => measure())
      resized.observe(el)
      measure()
      return () => {
        resized.disconnect()
        scroller.current = null
      }
    },
    [measure],
  )

  const [active, setActive] = useState<Cell>({ row: 0, column: 0 })
  const shownActive = {
    row: Math.min(active.row, rows.length - 1),
    column: Math.min(active.column, columns.length - 1),
  }
  const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN_ROWS)
  const last = Math.min(
    rows.length,
    Math.ceil((view.top + (view.height || ROW_HEIGHT * 30)) / ROW_HEIGHT) + OVERSCAN_ROWS,
  )
  const shown = useMemo(() => {
    const indexes: number[] = []
    for (let i = first; i < last; i++) indexes.push(i)
    if (shownActive.row >= 0 && (shownActive.row < first || shownActive.row >= last)) {
      indexes.push(shownActive.row)
    }
    return indexes
  }, [first, last, shownActive.row])
  const rendered = useMemo(() => shown.map((i) => rows[i]!), [shown, rows])
  const headlines = useHeadlines(props.headlines, rendered)

  const cells = useRef(new Map<string, HTMLElement>())
  const cellKey = (row: number, column: number) => `${row}:${column}`
  const pendingFocus = useRef<Cell | null>(null)
  const reveal = (row: number) => {
    const el = scroller.current
    if (!el) return
    const top = row * ROW_HEIGHT
    const head = ROW_HEIGHT
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_HEIGHT + head > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_HEIGHT + head - el.clientHeight
    }
  }
  const focusCell = (cell: Cell) => {
    setActive(cell)
    if (cell.row >= 0) reveal(cell.row)
    const el = cells.current.get(cellKey(cell.row, cell.column))
    if (el) el.focus({ preventScroll: true })
    else pendingFocus.current = cell
  }
  useLayoutEffect(() => {
    const cell = pendingFocus.current
    if (!cell) return
    const el = cells.current.get(cellKey(cell.row, cell.column))
    if (!el) return
    pendingFocus.current = null
    el.focus({ preventScroll: true })
  })

  // A note opened from elsewhere scrolls into view.
  const shownOpen = useRef(selected)
  useEffect(() => {
    if (shownOpen.current === selected) return
    shownOpen.current = selected
    const at = rows.findIndex((n) => n.id === selected)
    if (at >= 0) reveal(at)
  })

  const [editing, setEditingState] = useState<Editing | null>(null)
  // What the open editor holds, read by its blur, which can come after Return or Escape closed it.
  const editingNow = useRef<Editing | null>(null)
  const setEditing = (next: Editing | null) => {
    editingNow.current = next
    setEditingState(next)
  }
  const [notice, setNotice] = useState<MessageKey | null>(null)
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  const write = useStable(async (note: NoteSummary, key: string, value: PropertyValue) => {
    if (!onWrite) return
    const before = properties.get(note.id)?.[key]
    if (JSON.stringify(before ?? null) === JSON.stringify(value) && before !== undefined) return
    const undo = patch(note, key, value)
    try {
      await onWrite(note.id, key, value)
    } catch (e) {
      undo()
      console.warn('W_TABLE_WRITE_FAILED', errorCode(e), note.id)
      setNotice(writeMessage(e))
    }
  })

  const startEditing = (note: NoteSummary, column: TableColumn) => {
    if (!onWrite || !('key' in column)) return
    if (column.type === 'checkbox') {
      void write(note, column.key, properties.get(note.id)?.[column.key] !== true)
      return
    }
    setEditing({
      id: note.id,
      key: column.key,
      type: column.type,
      text: editText(properties.get(note.id)?.[column.key]),
    })
  }
  /** Closes the cell's editor once, writing what it holds when `keep`; `then` takes the keyboard, none on a blur. */
  const finishEditing = (keep: boolean, then: Cell | null) => {
    const was = editingNow.current
    if (!was) return
    setEditing(null)
    if (keep) {
      const note = notes.find((n) => n.id === was.id)
      if (note) void write(note, was.key, parseCell(was.type, was.text))
    }
    if (then) focusCell(then)
  }

  const showMenu = useContextMenu('tableColumn', COLUMN_MENU, (action, target) => {
    const id = target.column.id
    const was = target.settings
    if (action === 'sortAscending')
      changeSettings({ ...was, sort: { column: id, descending: false } })
    else if (action === 'sortDescending')
      changeSettings({ ...was, sort: { column: id, descending: true } })
    else if (action === 'clearSort') changeSettings({ ...was, sort: undefined })
    else if (action === 'clearFilter') changeSettings(withFilter(was, id, undefined))
    else if (action === 'hide') {
      const hidden = [...was.hidden.filter((h) => h !== id), id]
      changeSettings(withFilter({ ...was, hidden }, id, undefined))
    } else if (action === 'showAll') changeSettings({ ...was, hidden: [] })
    else changeSettings(withFilter(was, id, filteredAs(target, action) ? undefined : action))
  })
  const openColumnMenu = (column: TableColumn, anchor: HTMLElement) => {
    const box = anchor.getBoundingClientRect()
    void showMenu({ column, settings }, { x: box.left, y: box.bottom })
  }

  const [adding, setAdding] = useState<{ text: string; invalid: boolean } | null>(null)
  const addProperty = () => {
    if (!adding) return
    const key = adding.text.trim()
    if (!validPropertyKey(key)) return setAdding({ ...adding, invalid: true })
    setAdding(null)
    const id = propertyColumnId(key)
    if (!columns.some((c) => c.id === id)) {
      changeSettings({
        ...settings,
        added: [...settings.added.filter((k) => k !== key), key],
        hidden: settings.hidden.filter((h) => h !== id),
      })
    }
  }

  const moveKey = (event: KeyboardEvent, cell: Cell): boolean => {
    if (event.metaKey || event.ctrlKey || event.altKey) return false
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1)
    const rtl = scroller.current ? getComputedStyle(scroller.current).direction === 'rtl' : false
    const across = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    let next: Cell | undefined
    if (across) next = { row: cell.row, column: cell.column + (rtl ? -across : across) }
    else if (event.key === 'ArrowDown') next = { row: cell.row + 1, column: cell.column }
    else if (event.key === 'ArrowUp') next = { row: cell.row - 1, column: cell.column }
    else if (event.key === 'Home') next = { row: cell.row, column: 0 }
    else if (event.key === 'End') next = { row: cell.row, column: columns.length - 1 }
    else if (event.key === 'PageDown')
      next = { row: Math.min(rows.length - 1, cell.row + page), column: cell.column }
    else if (event.key === 'PageUp')
      next = { row: Math.max(0, cell.row - page), column: cell.column }
    if (!next) return false
    event.preventDefault()
    const row = Math.max(-1, Math.min(rows.length - 1, next.row))
    const column = Math.max(0, Math.min(columns.length - 1, next.column))
    focusCell({ row, column })
    return true
  }

  const cellKeyDown = (event: KeyboardEvent<HTMLElement>, cell: Cell) => {
    if (event.target !== event.currentTarget) return
    if (moveKey(event, cell)) return
    const note = rows[cell.row]
    const column = columns[cell.column]
    if (!column) return
    if (props.onFind && commandMatches('search.fromList', event)) {
      event.preventDefault()
      return props.onFind()
    }
    if (!note) return
    if (props.onMenu && commandMatches('list.rowMenu', event)) {
      event.preventDefault()
      const box = event.currentTarget.getBoundingClientRect()
      return props.onMenu(note.id, { x: box.left, y: box.bottom })
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const editable = onWrite && 'key' in column
    if (event.key === 'Enter') {
      event.preventDefault()
      if ('field' in column) return onSelect(note.id)
      return startEditing(note, column)
    }
    if (event.key === 'F2' || (event.key === ' ' && editable && column.type === 'checkbox')) {
      event.preventDefault()
      return startEditing(note, column)
    }
    if (editable && (event.key === 'Backspace' || event.key === 'Delete')) {
      event.preventDefault()
      void write(note, column.key, null)
    }
  }

  const emptyText =
    props.empty && notes.length === 0
      ? listEmpty(props.empty, props.editing, !!props.onSearchAll)
      : undefined
  const filtered = Object.keys(settings.filters).length > 0
  const tabStop = rows.length === 0 ? { row: -1, column: 0 } : shownActive
  const template = columns
    .map((c) =>
      c.id === 'field:title' ? 'var(--size-table-title-width)' : 'var(--size-table-column-width)',
    )
    .join(' ')
  const gridStyle = {
    '--table-columns': `${template} var(--size-table-column-width)`,
  } as CSSProperties

  const headCell = (column: TableColumn, index: number) => {
    const sorted = settings.sort?.column === column.id ? settings.sort : undefined
    const name = columnName(column)
    return (
      <div
        key={column.id}
        role="columnheader"
        className={`table-head-cell${index === 0 ? ' table-sticky' : ''}`}
        aria-colindex={index + 1}
        aria-sort={sorted ? (sorted.descending ? 'descending' : 'ascending') : undefined}
      >
        <button
          ref={(el) => {
            const key = cellKey(-1, index)
            if (el) cells.current.set(key, el)
            else cells.current.delete(key)
          }}
          type="button"
          className="table-head-button"
          tabIndex={tabStop.row === -1 && tabStop.column === index ? 0 : -1}
          aria-label={
            'type' in column
              ? format(t('table.columnHeader'), { column: name, type: typeLabel(column.type) })
              : name
          }
          title={'type' in column ? typeLabel(column.type) : undefined}
          aria-haspopup="menu"
          onFocus={() => setActive({ row: -1, column: index })}
          onClick={(e) => openColumnMenu(column, e.currentTarget)}
          onKeyDown={(e) => {
            if (moveKey(e, { row: -1, column: index })) return
          }}
        >
          <span className="table-head-name" dir="auto">
            {name}
          </span>
          {sorted ? (
            <span
              className="table-head-mark"
              role="img"
              aria-label={t(sorted.descending ? 'table.sortedDescending' : 'table.sortedAscending')}
            >
              <Icon
                name={sorted.descending ? 'table.sortDescending' : 'table.sortAscending'}
                size="sm"
              />
            </span>
          ) : null}
          {settings.filters[column.id] ? (
            <span className="table-head-mark" role="img" aria-label={t('table.filtered')}>
              <Icon name="filter" size="sm" />
            </span>
          ) : null}
        </button>
      </div>
    )
  }

  const cellContent = (note: NoteSummary, column: TableColumn): ReactNode => {
    if ('field' in column) {
      if (column.field === 'title') {
        const title = displayTitle(note.title, headlines.get(note.id))
        return (
          <span className={note.title ? 'table-title' : 'table-title is-untitled'} dir="auto">
            {title}
          </span>
        )
      }
      if (column.field === 'status') {
        return note.status === 'none' ? null : (
          <span className={`table-status status-${note.status}`}>
            <Icon name={STATUS_ICONS[note.status]} size="sm" />
            <span className="table-text">{t(`status.${note.status}`)}</span>
          </span>
        )
      }
      if (column.field === 'updated') {
        return (
          <time
            dateTime={new Date(note.updatedAt).toISOString()}
            title={fullDate(note.updatedAt, locale)}
          >
            {rowDate(note.updatedAt, now, locale, dates)}
          </time>
        )
      }
      return (
        <span className="table-text" dir="auto">
          {tagNames(note).join(', ')}
        </span>
      )
    }
    const value = properties.get(note.id)?.[column.key]
    if (value === undefined || value === null) return null
    if (column.type === 'checkbox' || typeof value === 'boolean') {
      return (
        <input
          type="checkbox"
          className="table-check"
          tabIndex={-1}
          aria-label={column.key}
          checked={value === true}
          disabled={!onWrite}
          onChange={() => void write(note, column.key, value !== true)}
        />
      )
    }
    if (Array.isArray(value)) {
      return (
        <span className="table-chips">
          {value.map((item, i) => (
            <span key={i} className="table-chip" dir="auto">
              {item}
            </span>
          ))}
        </span>
      )
    }
    const text =
      column.type === 'date' && typeof value === 'string' ? dayText(value, locale) : String(value)
    return (
      <span className="table-text" dir="auto">
        {text}
      </span>
    )
  }

  const bodyCell = (note: NoteSummary, rowIndex: number, column: TableColumn, index: number) => {
    const isEditing =
      editing !== null && 'key' in column && editing.id === note.id && editing.key === column.key
    const tabbable = tabStop.row === rowIndex && tabStop.column === index
    const numeric = 'type' in column && column.type === 'number'
    return (
      <div
        key={column.id}
        ref={(el) => {
          const key = cellKey(rowIndex, index)
          if (el) cells.current.set(key, el)
          else if (cells.current.get(key)?.isConnected === false) cells.current.delete(key)
        }}
        role={index === 0 ? 'rowheader' : 'gridcell'}
        className={`table-cell${index === 0 ? ' table-sticky' : ''}${numeric ? ' is-number' : ''}`}
        aria-colindex={index + 1}
        aria-readonly={'key' in column && onWrite ? undefined : true}
        tabIndex={tabbable && !isEditing ? 0 : -1}
        onFocus={(e) => {
          if (e.target === e.currentTarget) setActive({ row: rowIndex, column: index })
        }}
        onMouseDown={() => setActive({ row: rowIndex, column: index })}
        onClick={(e) => {
          if (index === 0) onSelect(note.id)
          else if ((e.target as HTMLElement).tagName !== 'INPUT') e.currentTarget.focus()
        }}
        onDoubleClick={() => {
          if ('key' in column && column.type !== 'checkbox') startEditing(note, column)
        }}
        onKeyDown={(e) => cellKeyDown(e, { row: rowIndex, column: index })}
      >
        {isEditing ? (
          <input
            className="table-input"
            type={editing.type === 'date' ? 'date' : 'text'}
            inputMode={editing.type === 'number' ? 'decimal' : undefined}
            aria-label={format(t('table.editCell'), { column: columnName(column) })}
            value={editing.text}
            autoFocus
            dir="auto"
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            onBlur={() => finishEditing(true, null)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                finishEditing(false, { row: rowIndex, column: index })
              } else if (e.key === 'Enter') {
                e.preventDefault()
                finishEditing(true, { row: rowIndex, column: index })
              } else if (e.key === 'Tab') {
                e.preventDefault()
                const to = Math.max(0, Math.min(columns.length - 1, index + (e.shiftKey ? -1 : 1)))
                finishEditing(true, { row: rowIndex, column: to })
              }
            }}
          />
        ) : (
          cellContent(note, column)
        )}
      </div>
    )
  }

  return (
    <section
      className="list table-layout"
      data-devot-part="list"
      aria-label={t('noteList.label')}
      style={{ '--list-width': `${width}px` } as CSSProperties}
    >
      <ListHeader
        title={props.title}
        scope={props.scope}
        count={rows.length}
        capped={props.capped}
        icon={props.icon}
        onTitleMenu={props.onTitleMenu}
        leading={props.leading}
        onCreate={props.onCreate}
        filter={props.filter}
        sort={props.sort}
        sortButtonRef={props.sortButtonRef}
        layout={props.layout}
        onFilterDone={() => focusCell(tabStop)}
      />
      {emptyText ? (
        <ListEmptyContent text={emptyText} onSearchAll={props.onSearchAll} />
      ) : (
        <div ref={observeScroller} className="table-scroll" onScroll={measure}>
          <div
            role="grid"
            className="table-grid"
            aria-label={t('noteList.label')}
            aria-rowcount={rows.length + 1}
            aria-colcount={columns.length}
            style={gridStyle}
          >
            <div role="row" className="table-row table-head" aria-rowindex={1}>
              {columns.map(headCell)}
              <div role="presentation" className="table-head-cell table-add">
                {adding ? (
                  <input
                    className="table-input"
                    aria-label={t('table.propertyName')}
                    placeholder={t('table.propertyName')}
                    aria-invalid={adding.invalid || undefined}
                    title={adding.invalid ? t('table.propertyInvalid') : undefined}
                    value={adding.text}
                    autoFocus
                    dir="auto"
                    onChange={(e) => setAdding({ text: e.target.value, invalid: false })}
                    onBlur={() => setAdding(null)}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing) return
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addProperty()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        e.stopPropagation()
                        setAdding(null)
                      }
                    }}
                  />
                ) : onWrite ? (
                  <button
                    type="button"
                    className="tool table-add-button"
                    aria-label={t('table.addProperty')}
                    title={t('table.addProperty')}
                    onClick={() => setAdding({ text: '', invalid: false })}
                  >
                    <Icon name="table.addProperty" size="sm" />
                  </button>
                ) : null}
              </div>
            </div>
            {adding?.invalid ? (
              <div className="table-notice" role="alert">
                {t('table.propertyInvalid')}
              </div>
            ) : null}
            {rows.length === 0 && filtered ? (
              <div className="table-none">
                <ListEmptyContent text={{ message: 'table.noMatches' }} />
                <button
                  type="button"
                  className="button"
                  onClick={() => changeSettings({ ...settings, filters: {} })}
                >
                  {t('table.clearFilters')}
                </button>
              </div>
            ) : (
              <div className="table-body" style={{ height: rows.length * ROW_HEIGHT }}>
                {shown.map((rowIndex) => {
                  const note = rows[rowIndex]!
                  const isSelected = note.id === (props.opening ?? selected)
                  return (
                    <div
                      key={note.id}
                      role="row"
                      className="table-row"
                      aria-rowindex={rowIndex + 2}
                      aria-selected={isSelected}
                      data-note-id={note.id}
                      style={{ top: rowIndex * ROW_HEIGHT }}
                      onContextMenu={
                        props.onMenu
                          ? (e) => {
                              e.preventDefault()
                              props.onMenu?.(note.id)
                            }
                          : undefined
                      }
                    >
                      {columns.map((column, index) => bodyCell(note, rowIndex, column, index))}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
      {notice ? (
        <div className="table-notice" role="alert">
          {t(notice)}
        </div>
      ) : null}
      <div className="list-resize" aria-label={t('table.resize')} {...edge} />
    </section>
  )
})
