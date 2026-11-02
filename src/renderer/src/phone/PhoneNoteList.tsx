import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { BookRecord, NoteStatus, NoteSummary, TagRecord } from '../../../core/storage'
import { BookIcon } from '../BookIcon'
import { noteDate } from '../format'
import { displayTitle } from '../headlines'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import type { IconName } from '../icons/symbols'
import { doveMask } from './dove'
import { haptic } from './haptics'
import type { PhoneStatusFilter, PhoneView } from './library'
import { filterCounts, inView, orderNotes, PHONE_FILTERS, withStatus } from './noteList'
import { NotebookPicker, STATUS_LABEL, StatusMark, statusTile } from './pickers'
import { decideGesture, isArmed, PEEK_MS, release, swipeOffset, SWIPE_OPEN } from './swipe'
import type { PhoneData, PhoneStore } from './usePhoneData'

const FILTER_LABEL: Readonly<Record<PhoneStatusFilter, MessageKey>> = {
  all: 'phone.filter.all',
  active: 'status.active',
  on_hold: 'status.on_hold',
  completed: 'phone.library.done',
}

type RowAction = 'pin' | 'trash' | 'done'

const ACTIONS: readonly { key: RowAction; icon: IconName }[] = [
  { key: 'pin', icon: 'phone.swipe.pin' },
  { key: 'trash', icon: 'phone.swipe.trash' },
  { key: 'done', icon: 'phone.swipe.done' },
]

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

export function Avatar(props: { book: BookRecord | undefined }) {
  const color = props.book?.iconColor
  return (
    <span
      className="phone-avatar"
      style={{
        ['--avatar' as string]: color ? `var(--color-tag-${color})` : 'var(--color-phone-dove)',
      }}
    >
      {props.book ? (
        <BookIcon icon={props.book.icon} color={null} size="lg" />
      ) : (
        <span aria-hidden="true" className="phone-dove phone-dove-avatar" style={doveMask} />
      )}
    </span>
  )
}

function StatusBadge(props: { status: NoteStatus }) {
  const [shown, setShown] = useState(props.status)
  const [bumps, setBumps] = useState(0)
  if (shown !== props.status) {
    setShown(props.status)
    setBumps((n) => n + 1)
  }
  if (props.status === 'none') return null
  return (
    <span
      className="phone-status-badge"
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
  book: BookRecord | undefined
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

function NoteRow(props: RowProps) {
  const { note } = props
  const [drag, setDrag] = useState<number | null>(null)
  const [pressed, setPressed] = useState(false)
  const press = useRef<{
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

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (!props.swipes) return
    if (props.closeOthers()) {
      press.current = {
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
    if (!p || p.mode === 'swallowed' || p.mode === 'peek' || p.mode === 'scroll') return
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

  const end = (event: PointerEvent<HTMLDivElement>) => {
    const p = press.current
    press.current = null
    setPressed(false)
    if (!p) return
    clearTimeout(p.timer)
    if (p.mode !== 'swipe') return
    suppressClick.current = true
    wasArmed.current = false
    const at = drag ?? base
    setDrag(null)
    const rested = event.timeStamp - p.lastAt > 100
    const outcome = event.type === 'pointerup' ? release(at, rested ? 0 : p.speed) : 'closed'
    if (outcome === 'complete') {
      props.onOpenChange(false)
      props.onAction('done')
    } else props.onOpenChange(outcome === 'open')
  }

  const armed = isArmed(offset)
  const progress = Math.min(2, Math.max(0, -offset / SWIPE_OPEN))
  return (
    <li
      className="phone-note-row"
      data-pinned={note.pinned || undefined}
      data-arrived={props.arrived || undefined}
    >
      {props.swipes && (
        <div className="phone-swipe-actions" aria-hidden={offset === 0 || undefined}>
          {ACTIONS.map((action, i) => {
            const shown = Math.min(1, Math.max(0, (progress - (2 - i) * 0.12) / 0.76))
            const hidden = armed && action.key !== 'done'
            return (
              <button
                key={action.key}
                type="button"
                tabIndex={offset === 0 ? -1 : 0}
                className="phone-swipe-action"
                data-action={action.key}
                data-stretched={(armed && action.key === 'done') || undefined}
                style={{
                  ['--phone-swipe-scale' as string]: hidden ? 0.2 : shown,
                  ['--stretch' as string]: `${armed && action.key === 'done' ? Math.max(50, -offset - 20) : 50}px`,
                  opacity: hidden ? 0 : Math.min(1, shown * 1.6),
                }}
                onClick={() => {
                  props.onOpenChange(false)
                  props.onAction(action.key)
                }}
              >
                <span className="phone-swipe-circle">
                  <Icon name={action.icon} size="lg" />
                </span>
                <span className="phone-swipe-label">{actionLabel(action.key, note)}</span>
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
        onPointerUp={end}
        onPointerCancel={end}
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
          <span className="phone-avatar-slot">
            <Avatar book={props.book} />
            <StatusBadge status={note.status} />
          </span>
          <span className="phone-note-text">
            <span className="phone-note-line">
              <span className="phone-note-title">{props.title}</span>
              <span className="phone-note-time phone-figures">
                {noteDate(note.updatedAt, props.now, currentLocale())}
              </span>
            </span>
            <span className="phone-note-line">
              <span className="phone-note-excerpt">
                {props.tag && (
                  <span
                    className="phone-note-tag"
                    style={{
                      color: props.tag.color
                        ? `var(--color-tag-text-${props.tag.color})`
                        : 'var(--color-phone-text-secondary)',
                    }}
                  >
                    #{props.tag.name}{' '}
                  </span>
                )}
                {props.excerpt}
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
  const [moving, setMoving] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  const book = props.data.books.find((b) => b.id === props.note.bookId)
  if (moving)
    return (
      <NotebookPicker
        books={props.data.books}
        current={props.note.bookId}
        onClose={props.onClose}
        onPick={(bookId) => {
          void props.data.core?.setBook(props.note.id, bookId)
          props.onClose()
        }}
      />
    )
  return (
    <div className="phone-peek-layer" data-shown={shown || undefined}>
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
          </button>
          <button type="button" role="menuitem" onClick={() => props.onAction('pin')}>
            {actionLabel('pin', props.note)}
          </button>
          <button type="button" role="menuitem" onClick={() => setMoving(true)}>
            {t('phone.moveTo')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-destructive
            onClick={() => props.onAction('trash')}
          >
            {t('note.moveToTrash')}
          </button>
        </div>
      </div>
    </div>
  )
}

function useExcerpts(data: PhoneData, notes: readonly NoteSummary[]): ReadonlyMap<string, string> {
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

export function PhoneNoteList(props: {
  data: PhoneStore
  view: PhoneView
  status: PhoneStatusFilter
  title: string
  arrivedId: string | null
  onBack?: () => void
  onOpenNote: (id: string) => void
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
  const books = new Map(data.books.map((b) => [b.id, b]))
  const tags = new Map(data.tags.map((tag) => [tag.id, tag]))
  const titleOf = (n: NoteSummary) => displayTitle(n.title, excerpts.get(n.id)?.split('\n')[0])

  const act = (note: NoteSummary, key: RowAction) => {
    const core = data.core
    if (!core) return
    setPeekId(null)
    if (key === 'pin') void core.setPinned(note.id, !note.pinned)
    else if (key === 'trash') void core.trash(note.id).then(data.refresh)
    else {
      haptic('success')
      void core.setStatus(note.id, 'completed')
    }
  }
  const peek = peekId ? rows.find((n) => n.id === peekId) : undefined

  return (
    <section aria-label={props.title} className="phone-screen">
      <div className="phone-scroll phone-list-scroll">
        {rows.length === 0 ? (
          <p className="phone-list-empty">{t('phone.list.empty')}</p>
        ) : (
          <ul className="phone-note-list">
            {rows.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                title={titleOf(note)}
                excerpt={excerpts.get(note.id) ?? ''}
                book={note.bookId ? books.get(note.bookId) : undefined}
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
            ))}
          </ul>
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
            disabled
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
            haptic('selection')
            setPeekId(null)
            void data.core?.setStatus(peek.id, next)
          }}
          onAction={(key) => act(peek, key)}
        />
      )}
    </section>
  )
}
