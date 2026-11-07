import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { NoteStatus, NoteSummary, TagRecord } from '../../../core/storage'
import { noteDate } from '../format'
import { displayTitle } from '../headlines'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import { tagColorClass, tagColorStyle } from '../tagColorStyle'
import type { IconName } from '../icons/symbols'
import { watchDragEnd, type DragEnd } from './dragEnd'
import { haptic } from './haptics'
import type { PhoneStatusFilter, PhoneView } from './library'
import {
  filterCounts,
  inView,
  noteSections,
  orderNotes,
  PHONE_FILTERS,
  sectionCollapsed,
  withStatus,
  type NoteSectionKey,
  type SectionChoices,
} from './noteList'
import { NotebookPicker, STATUS_LABEL, StatusMark, statusTile } from './pickers'
import { requireEditing, watchWrite, type WriteOp } from './requireEditing'
import {
  decideGesture,
  isArmed,
  PEEK_MS,
  release,
  swipeActionLook,
  swipeOffset,
  SWIPE_OPEN,
} from './swipe'
import type { PhoneData, PhoneStore } from './usePhoneData'
import { Marked } from '../Marked'

const FILTER_LABEL: Readonly<Record<PhoneStatusFilter, MessageKey>> = {
  all: 'phone.filter.all',
  active: 'status.active',
  on_hold: 'status.on_hold',
  completed: 'phone.library.done',
}

type RowAction = 'pin' | 'trash' | 'done'

const ACTIONS: readonly RowAction[] = ['pin', 'trash', 'done']
const ROW_OPS: Readonly<Record<RowAction, WriteOp>> = {
  pin: 'pin',
  trash: 'trash',
  done: 'complete',
}

const actionIcon = (key: RowAction, note: NoteSummary): IconName =>
  key === 'pin'
    ? note.pinned
      ? 'phone.swipe.unpin'
      : 'phone.swipe.pin'
    : key === 'trash'
      ? 'phone.swipe.trash'
      : 'phone.swipe.done'

const SECTION_TITLE: Readonly<Record<NoteSectionKey, MessageKey>> = {
  pinned: 'sidebar.pinned',
  recent: 'phone.list.recent',
  completed: 'status.completed',
}

const actionLabel = (key: RowAction, note: NoteSummary): string =>
  t(
    key === 'pin'
      ? note.pinned
        ? 'note.unpin'
        : 'phone.action.pin'
      : key === 'trash'
        ? 'phone.action.trash'
        : 'phone.library.done',
  )

function NoteMark(props: { status: NoteStatus }) {
  const [shown, setShown] = useState(props.status)
  const [bumps, setBumps] = useState(0)
  if (shown !== props.status) {
    setShown(props.status)
    setBumps((n) => n + 1)
  }
  return (
    <span
      className="phone-note-mark"
      role="img"
      aria-label={t(STATUS_LABEL[props.status])}
      data-bump={bumps === 0 ? undefined : bumps % 2 ? 'a' : 'b'}
    >
      <StatusMark status={props.status} />
    </span>
  )
}

interface RowProps {
  note: NoteSummary
  title: string
  excerpt: string
  titlePattern?: RegExp | null
  excerptPattern?: RegExp | null
  /** Shown in place of the time, as a search result shows its notebook. */
  meta?: string
  tag: TagRecord | undefined
  now: number
  open: boolean
  swipes: boolean
  arrived: boolean
  onOpenChange: (open: boolean) => void
  /** True when a tap closed another row: this press does nothing else. */
  closeOthers: () => boolean
  onOpen: () => void
  onPeek: () => void
  onAction: (key: RowAction) => void
}

export function NoteRow(props: RowProps) {
  const { note } = props
  const [drag, setDrag] = useState<number | null>(null)
  const [pressed, setPressed] = useState(false)
  const press = useRef<{
    pointer: number
    stop: () => void
    x: number
    y: number
    at: number
    lastX: number
    lastAt: number
    speed: number
    mode: 'pending' | 'swipe' | 'scroll' | 'peek' | 'swallowed'
    timer: ReturnType<typeof setTimeout> | undefined
  } | null>(null)
  const suppressClick = useRef(false)
  const wasArmed = useRef(false)
  const base = props.open ? -SWIPE_OPEN : 0
  const offset = drag ?? base

  const latestEnd = useRef<(how: DragEnd, event: globalThis.PointerEvent | null) => void>(
    () => undefined,
  )
  useEffect(() => () => press.current?.stop(), [])

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (!props.swipes || press.current) return
    const pointer = event.pointerId
    const stop = watchDragEnd(event.currentTarget, pointer, (how, e) => latestEnd.current(how, e))
    if (props.closeOthers()) {
      press.current = {
        pointer,
        stop,
        x: 0,
        y: 0,
        at: 0,
        lastX: 0,
        lastAt: 0,
        speed: 0,
        mode: 'swallowed',
        timer: undefined,
      }
      suppressClick.current = true
      return
    }
    const at = event.timeStamp
    const timer = props.open
      ? undefined
      : setTimeout(() => {
          const p = press.current
          if (!p || p.mode !== 'pending') return
          p.mode = 'peek'
          suppressClick.current = true
          setPressed(false)
          haptic('light')
          props.onPeek()
        }, PEEK_MS)
    press.current = {
      pointer,
      stop,
      x: event.clientX,
      y: event.clientY,
      at,
      lastX: event.clientX,
      lastAt: at,
      speed: 0,
      mode: 'pending',
      timer,
    }
    if (!props.open) setPressed(true)
  }

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const p = press.current
    if (!p || p.pointer !== event.pointerId) return
    if (p.mode === 'swallowed' || p.mode === 'peek' || p.mode === 'scroll') return
    const dx = event.clientX - p.x
    const dy = event.clientY - p.y
    if (p.mode === 'pending') {
      const mode = decideGesture({ dx, dy, heldMs: event.timeStamp - p.at, open: props.open })
      if (mode === 'scroll') {
        clearTimeout(p.timer)
        p.mode = 'scroll'
        setPressed(false)
        return
      }
      if (mode !== 'swipe') return
      clearTimeout(p.timer)
      p.mode = 'swipe'
      setPressed(false)
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    const elapsed = event.timeStamp - p.lastAt
    if (elapsed > 0) p.speed = (event.clientX - p.lastX) / elapsed
    p.lastX = event.clientX
    p.lastAt = event.timeStamp
    const next = swipeOffset(base, dx)
    const armed = isArmed(next)
    if (armed !== wasArmed.current) {
      wasArmed.current = armed
      haptic('selection')
    }
    setDrag(next)
  }

  const end = (how: DragEnd, event: globalThis.PointerEvent | null) => {
    const p = press.current
    press.current = null
    setPressed(false)
    if (!p) return
    clearTimeout(p.timer)
    // Only a release is followed by a click to swallow.
    suppressClick.current = how === 'release' && p.mode !== 'pending' && p.mode !== 'scroll'
    if (p.mode !== 'swipe') return
    wasArmed.current = false
    const at = drag ?? base
    setDrag(null)
    const outcome =
      how === 'release' && event
        ? release(at, event.timeStamp - p.lastAt > 100 ? 0 : p.speed)
        : 'closed'
    if (outcome === 'complete') {
      props.onOpenChange(false)
      props.onAction('done')
    } else props.onOpenChange(outcome === 'open')
  }
  useLayoutEffect(() => {
    latestEnd.current = end
  })

  return (
    <li className="phone-note-row" data-arrived={props.arrived || undefined}>
      {props.swipes && (
        <div className="phone-swipe-actions" aria-hidden={offset === 0 || undefined}>
          {ACTIONS.map((key, i) => {
            const look = swipeActionLook(offset, i, ACTIONS.length)
            return (
              <button
                key={key}
                type="button"
                tabIndex={offset === 0 ? -1 : 0}
                className="phone-swipe-action"
                data-action={key}
                data-stretched={look.stretched || undefined}
                style={{
                  ['--phone-swipe-scale' as string]: look.grown,
                  ['--stretch' as string]: `${look.width}px`,
                  opacity: look.opacity,
                }}
                onClick={() => {
                  props.onOpenChange(false)
                  props.onAction(key)
                }}
              >
                <span className="phone-swipe-capsule">
                  <Icon name={actionIcon(key, note)} size="toolbar" />
                </span>
                <span className="phone-swipe-label">{actionLabel(key, note)}</span>
              </button>
            )
          })}
        </div>
      )}
      <div
        className="phone-note-content"
        data-raised={offset < -2 || undefined}
        data-pressed={pressed || undefined}
        data-dragging={drag !== null || undefined}
        style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={down}
        onPointerMove={move}
        onContextMenu={(event) => event.preventDefault()}
      >
        <button
          type="button"
          className="phone-note-open"
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false
              return
            }
            if (props.open) props.onOpenChange(false)
            else props.onOpen()
          }}
        >
          <NoteMark status={note.status} />
          <span className="phone-note-text">
            <span className="phone-note-line">
              <span className="phone-note-title">
                <Marked text={props.title} pattern={props.titlePattern} className="phone-match" />
              </span>
              {props.meta === undefined ? (
                <span className="phone-note-time phone-figures">
                  {noteDate(note.updatedAt, props.now, currentLocale())}
                </span>
              ) : (
                <span className="phone-note-time phone-note-book phone-mono">{props.meta}</span>
              )}
            </span>
            <span className="phone-note-line">
              <span className="phone-note-excerpt">
                {props.tag && (
                  <span
                    className={`phone-row-tag ${tagColorClass(props.tag.color)}`}
                    style={tagColorStyle(props.tag.color)}
                  >
                    #{props.tag.name}{' '}
                  </span>
                )}
                <Marked
                  text={props.excerpt}
                  pattern={props.excerptPattern}
                  className="phone-match"
                />
              </span>
              {note.pinned && (
                <span className="phone-note-pin" role="img" aria-label={t('sidebar.pinned')}>
                  <Icon name="note.pinned" size="sm" />
                </span>
              )}
            </span>
          </span>
        </button>
        {props.swipes && (
          <button
            type="button"
            className="phone-visually-hidden"
            aria-label={format(t('phone.rowActions'), { title: props.title })}
            onClick={props.onPeek}
          />
        )}
      </div>
    </li>
  )
}

function Peek(props: {
  note: NoteSummary
  title: string
  excerpt: string
  data: PhoneData
  onClose: () => void
  onOpen: () => void
  onStatus: (status: NoteStatus) => void
  onAction: (key: RowAction) => void
}) {
  const [shown, setShown] = useState(false)
  const [settled, setSettled] = useState(false)
  const [moving, setMoving] = useState(false)
  const layer = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  useEffect(() => {
    const el = layer.current
    if (!shown || !el) return
    let alive = true
    // A cancelled transition rejects `finished`; either way the layers can be released.
    void Promise.allSettled(el.getAnimations({ subtree: true }).map((a) => a.finished)).then(() => {
      if (alive) setSettled(true)
    })
    return () => {
      alive = false
    }
  }, [shown])
  const book = props.data.books.find((b) => b.id === props.note.bookId)
  if (moving)
    return (
      <NotebookPicker
        books={props.data.books}
        current={props.note.bookId}
        onClose={props.onClose}
        onPick={(bookId) => {
          const core = props.data.core
          if (core) watchWrite('move', core.setBook(props.note.id, bookId))
          props.onClose()
        }}
      />
    )
  return (
    <div
      ref={layer}
      className="phone-peek-layer"
      data-shown={shown || undefined}
      data-settled={settled || undefined}
    >
      <div className="phone-peek-dim" onClick={props.onClose} aria-hidden="true" />
      <div className="phone-peek" role="dialog" aria-modal="true" aria-label={props.title}>
        <div
          role="group"
          aria-label={t('phone.setStatus')}
          className="phone-glass phone-peek-status"
        >
          {(['active', 'on_hold', 'completed', 'dropped'] as const).map((status) => (
            <button
              key={status}
              type="button"
              className="phone-peek-status-button"
              aria-label={t(STATUS_LABEL[status])}
              aria-pressed={props.note.status === status}
              style={props.note.status === status ? { background: statusTile(status) } : undefined}
              onClick={() => props.onStatus(status)}
            >
              <StatusMark status={status} />
            </button>
          ))}
        </div>
        <article className="phone-peek-card">
          <span className="phone-peek-meta">
            {book ? `${book.name} · ` : ''}
            {noteDate(props.note.updatedAt, props.data.loadedAt, currentLocale())}
          </span>
          <h2 className="phone-peek-title">{props.title}</h2>
          <p className="phone-peek-excerpt">{props.excerpt}</p>
        </article>
        <div role="menu" className="phone-glass phone-peek-menu">
          <button type="button" role="menuitem" onClick={props.onOpen}>
            {t('phone.open')}
            <Icon name="phone.open" size="phone-status" />
          </button>
          <button type="button" role="menuitem" onClick={() => props.onAction('pin')}>
            {actionLabel('pin', props.note)}
            <Icon name={actionIcon('pin', props.note)} size="phone-status" />
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => requireEditing({ op: 'move', id: props.note.id }, () => setMoving(true))}
          >
            {t('phone.moveTo')}
            <Icon name="phone.move" size="phone-status" />
          </button>
          <button
            type="button"
            role="menuitem"
            data-destructive
            onClick={() => props.onAction('trash')}
          >
            {t('note.moveToTrash')}
            <Icon name="trash" size="phone-status" />
          </button>
        </div>
      </div>
    </div>
  )
}

export function useExcerpts(
  data: PhoneData,
  notes: readonly NoteSummary[],
): ReadonlyMap<string, string> {
  const [excerpts, setExcerpts] = useState<ReadonlyMap<string, string>>(() => new Map())
  const keys = notes.map((n) => `${n.id}:${n.bodyVersion}`).join(',')
  const ids = useMemo(() => (keys ? keys.split(',').map((key) => key.split(':')[0]!) : []), [keys])
  useEffect(() => {
    const core = data.core
    if (!core || ids.length === 0) return
    let alive = true
    void core
      .excerpts(ids)
      .then((found) => {
        if (alive) setExcerpts(new Map(Object.entries(found)))
      })
      .catch(() => console.warn('W_PHONE_EXCERPTS_FAILED'))
    return () => {
      alive = false
    }
  }, [data.core, ids])
  return excerpts
}

export function SectionHead(props: {
  title: string
  count?: number
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <h2 className="phone-list-head-title">
      <button
        type="button"
        className="phone-list-head"
        aria-expanded={!props.collapsed}
        data-collapsed={props.collapsed || undefined}
        onClick={props.onToggle}
      >
        <span className="phone-list-head-name">{props.title}</span>
        {props.count !== undefined && (
          <span className="phone-list-head-count phone-figures">{props.count}</span>
        )}
        <span aria-hidden="true" className="phone-list-head-rule" />
        <span aria-hidden="true" className="phone-list-head-chevron">
          <Icon name="phone.section.chevron" size="sm" weight="medium" />
        </span>
      </button>
    </h2>
  )
}

export function PhoneNoteList(props: {
  data: PhoneStore
  view: PhoneView
  status: PhoneStatusFilter
  title: string
  arrivedId: string | null
  onBack?: () => void
  onOpenNote: (id: string) => void
  onSearch: () => void
  onTrash: (note: NoteSummary) => void
  onComplete: (note: NoteSummary) => void
}) {
  const { data } = props
  const [status, setStatus] = useState(props.status)
  const [shownStatus, setShownStatus] = useState(props.status)
  if (shownStatus !== props.status) {
    setShownStatus(props.status)
    setStatus(props.status)
  }
  const [openId, setOpenId] = useState<string | null>(null)
  const [peekId, setPeekId] = useState<string | null>(null)
  const [filtering, setFiltering] = useState(false)
  const [chosen, setChosen] = useState<SectionChoices>({})
  const [shownArrival, setShownArrival] = useState(props.arrivedId)
  if (shownArrival !== props.arrivedId) {
    setShownArrival(props.arrivedId)
    if (props.arrivedId !== null) {
      setChosen((before) => ({ ...before, recent: false }))
      if (status !== 'all' && status !== 'active') setStatus('all')
    }
  }
  const scroller = useRef<HTMLDivElement>(null)

  const source = useMemo((): NoteSummary[] => {
    if (props.view.kind === 'templates') return [...data.templates]
    if (props.view.kind === 'trash')
      return data.trash.map((n) => ({
        id: n.id,
        title: n.title,
        createdAt: n.deletedAt,
        updatedAt: n.deletedAt,
        bodyVersion: 0,
        bookId: n.bookId,
        status: 'none' as const,
        pinned: false,
        tagIds: [],
      }))
    return inView(data.notes, props.view, data.books)
  }, [data.notes, data.templates, data.trash, data.books, props.view])
  const counts = filterCounts(source)
  const rows = useMemo(() => orderNotes(withStatus(source, status)), [source, status])
  const excerpts = useExcerpts(data, props.view.kind === 'trash' ? [] : rows)
  const swipes = props.view.kind !== 'trash' && props.view.kind !== 'templates'
  const sections = useMemo(() => noteSections(rows), [rows])
  const tags = new Map(data.tags.map((tag) => [tag.id, tag]))
  const titleOf = (n: NoteSummary) => displayTitle(n.title, excerpts.get(n.id)?.split('\n')[0])

  const act = (note: NoteSummary, key: RowAction) => {
    setPeekId(null)
    requireEditing({ op: ROW_OPS[key], id: note.id }, () => {
      const core = data.core
      if (key === 'pin') {
        if (core) watchWrite('pin', core.setPinned(note.id, !note.pinned))
      } else if (key === 'trash') props.onTrash(note)
      else props.onComplete(note)
    })
  }
  const peek = peekId ? rows.find((n) => n.id === peekId) : undefined
  const hasArrived = props.arrivedId !== null && rows.some((n) => n.id === props.arrivedId)

  useLayoutEffect(() => {
    const scroll = scroller.current
    if (!hasArrived || !scroll) return
    const row = scroll.querySelector<HTMLElement>('.phone-note-row[data-arrived]')
    if (!row) return
    // The rows below shift by what it really takes, which Dynamic Type can change.
    scroll.style.setProperty('--phone-arrived-height', `${row.offsetHeight}px`)
    const topInset = Number.parseFloat(getComputedStyle(scroll).paddingTop)
    if (scroll.scrollTop > row.offsetTop - topInset) scroll.scrollTop = row.offsetTop - topInset
  }, [hasArrived])

  const toggleSection = (key: NoteSectionKey) => {
    setOpenId(null)
    setChosen((before) => ({ ...before, [key]: !sectionCollapsed(key, before, status) }))
  }
  const renderRow = (note: NoteSummary) => (
    <NoteRow
      key={note.id}
      note={note}
      title={titleOf(note)}
      excerpt={excerpts.get(note.id) ?? ''}
      tag={note.tagIds.map((id) => tags.get(id)).find((tag) => tag?.deletedAt === null)}
      now={data.loadedAt}
      open={openId === note.id}
      swipes={swipes}
      arrived={props.arrivedId === note.id}
      onOpenChange={(open) => setOpenId(open ? note.id : null)}
      closeOthers={() => {
        if (openId === null || openId === note.id) return false
        setOpenId(null)
        return true
      }}
      onOpen={() => props.onOpenNote(note.id)}
      onPeek={() => {
        setOpenId(null)
        setPeekId(note.id)
      }}
      onAction={(key) => act(note, key)}
    />
  )

  return (
    <section aria-label={props.title} className="phone-screen">
      <div ref={scroller} className="phone-scroll phone-list-scroll">
        {rows.length === 0 ? (
          <p className="phone-list-empty">{t('phone.list.empty')}</p>
        ) : !swipes ? (
          <ul className="phone-note-list">{rows.map(renderRow)}</ul>
        ) : (
          sections.map(({ key, notes }) => {
            const collapsed = sectionCollapsed(key, chosen, status)
            return (
              <section key={key} className="phone-note-section" data-section={key}>
                <SectionHead
                  title={t(SECTION_TITLE[key])}
                  count={notes.length}
                  collapsed={collapsed}
                  onToggle={() => toggleSection(key)}
                />
                {collapsed && key === 'completed' && (
                  <button
                    type="button"
                    className="phone-show-more"
                    onClick={() => toggleSection(key)}
                  >
                    <span className="phone-show-more-label">
                      {format(t('phone.list.showMore'), { count: String(notes.length) })}
                    </span>
                  </button>
                )}
                <div
                  className="phone-note-section-body"
                  data-collapsed={collapsed || undefined}
                  inert={collapsed}
                >
                  <ul className="phone-note-list">{notes.map(renderRow)}</ul>
                </div>
              </section>
            )
          })
        )}
      </div>
      <div aria-hidden="true" className="phone-topbar-band" />
      <header className="phone-topbar">
        {props.onBack && (
          <button
            type="button"
            className="phone-glass phone-nav-control"
            aria-label={t('phone.back')}
            onClick={props.onBack}
          >
            <Icon name="nav.back" size="lg" />
          </button>
        )}
        <h1 className="phone-topbar-title">{props.title}</h1>
        <div className="phone-glass phone-capsule">
          <button
            type="button"
            className="phone-capsule-button"
            aria-label={t('phone.filter.label')}
            aria-haspopup="menu"
            aria-expanded={filtering}
            data-active={status !== 'all' || undefined}
            onClick={() => setFiltering((shown) => !shown)}
          >
            <Icon name="phone.filter" size="lg" />
          </button>
          <button
            type="button"
            className="phone-capsule-button"
            aria-label={t('search.placeholder')}
            onClick={props.onSearch}
          >
            <Icon name="search" size="lg" />
          </button>
        </div>
      </header>
      {filtering && (
        <>
          <button
            type="button"
            className="phone-filter-scrim"
            aria-label={t('phone.close')}
            onClick={() => setFiltering(false)}
          />
          <div
            role="menu"
            aria-label={t('phone.filter.label')}
            className="phone-glass phone-peek-menu phone-filter-menu"
          >
            {PHONE_FILTERS.map((filter) => (
              <button
                key={filter}
                type="button"
                role="menuitemradio"
                aria-checked={filter === status}
                className="phone-filter-item"
                onClick={() => {
                  if (filter !== status) haptic('selection')
                  setOpenId(null)
                  setStatus(filter)
                  setFiltering(false)
                }}
              >
                <span className="phone-filter-item-label">{t(FILTER_LABEL[filter])}</span>
                <span className="phone-filter-item-count phone-figures">{counts[filter]}</span>
                {filter === status && <Icon name="check" size="sm" />}
              </button>
            ))}
          </div>
        </>
      )}
      {peek && (
        <Peek
          note={peek}
          title={titleOf(peek)}
          excerpt={excerpts.get(peek.id) ?? ''}
          data={data}
          onClose={() => setPeekId(null)}
          onOpen={() => {
            setPeekId(null)
            props.onOpenNote(peek.id)
          }}
          onStatus={(next) => {
            setPeekId(null)
            requireEditing({ op: 'status', id: peek.id }, () => {
              if (next === 'completed') {
                props.onComplete(peek)
                return
              }
              haptic('selection')
              const core = data.core
              if (core) watchWrite('status', core.setStatus(peek.id, next))
            })
          }}
          onAction={(key) => act(peek, key)}
        />
      )}
    </section>
  )
}
