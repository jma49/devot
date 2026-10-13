import {
  Fragment,
  memo,
  useCallback,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import type { NoteSummary, TagRecord } from '../../core'
import type { NoteStatus } from '../../core/storage'
import { matchSegments } from '../../core/search'
import { fullDate, relativeTime } from './format'
import { format, t } from './i18n'
import { Icon } from './icons/Icon'
import type { IconName } from './icons/symbols'
import { chipClass, TagDot } from './TagEditor'

/** Each status's icon, in its colour (see `.status-*`). */
export const STATUS_ICONS: Readonly<Record<NoteStatus, IconName>> = {
  none: 'status.none',
  active: 'status.active',
  on_hold: 'status.onHold',
  completed: 'status.completed',
  dropped: 'status.dropped',
}

/** `text` with the runs that match `pattern` in `<mark>`; text nodes only, never markup. */
export function Marked({ text, pattern }: { text: string; pattern: RegExp | null | undefined }) {
  if (!pattern) return text
  return matchSegments(text, pattern).map((s, i) =>
    s.match ? <mark key={i}>{s.text}</mark> : <Fragment key={i}>{s.text}</Fragment>,
  )
}

/** Task progress as the core reports it ("done/total", see NoteService.progress). */
export function parseProgress(
  text: string | undefined,
): { done: number; total: number } | undefined {
  const m = text ? /^(\d+)\/(\d+)$/.exec(text) : null
  if (!m) return undefined
  const done = Number(m[1])
  const total = Number(m[2])
  return total > 0 && done <= total ? { done, total } : undefined
}

/** A note's tasks: an icon, a small bar and "1 of 4". */
export function TaskProgress({ done, total }: { done: number; total: number }) {
  const values = { done: String(done), total: String(total) }
  return (
    <span className="row-progress">
      <Icon name="progress" size="sm" />
      <span
        className="progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label={format(t('noteList.progressLabel'), values)}
      >
        <span className="progress-fill" style={{ width: `${(done / total) * 100}%` }} />
      </span>
      <span className="progress-text" aria-hidden="true">
        {format(t('noteList.progress'), values)}
      </span>
    </span>
  )
}

/** What a row does with its events; one object for all rows, kept from render to render. */
export interface RowEvents {
  setRow: (id: string, el: HTMLLIElement | null) => void
  mouseDown: (event: MouseEvent<HTMLLIElement>) => void
  click: (id: string, event: MouseEvent<HTMLLIElement>) => void
  dragStart: (id: string, event: DragEvent<HTMLLIElement>) => void
  keyDown: (id: string, event: KeyboardEvent<HTMLLIElement>) => void
  contextMenu: (id: string, event: MouseEvent<HTMLLIElement>) => void
}

export interface RowProps {
  note: NoteSummary
  /** Its place in the list, 1-based, and the list's length; set while the list is windowed. */
  position: number | undefined
  setSize: number | undefined
  selected: boolean
  /** The row takes Tab (see `tabStop`). */
  tabbable: boolean
  tags: ReadonlyMap<string, TagRecord>
  /** Search results: what to mark in titles and in body excerpts (see `searchPattern`). */
  highlight: { title: RegExp | null; body: RegExp | null } | undefined
  /** What shows for a note with no title: its first line, once known (see `useHeadlines`). */
  headline: string | undefined
  /** The start of the note's body, once known (see `useHeadlines`). */
  preview: string | undefined
  /** The note's task progress, "done/total", when it has tasks (see NoteService.progress). */
  progress: string | undefined
  /** The time the row's relative date is measured from (see `useNow`). */
  now: number
  locale: string
  draggable: boolean
  /** Right-click shows the note menu. */
  menu: boolean
  events: RowEvents
}

/**
 * One note in the list: its title (none for an untitled note, whose first
 * line leads its excerpt instead), a meta line (when it changed, its status,
 * its tasks done and its tags) and one line of its body. It renders again
 * only when what it shows changes, so a list of any length costs one row
 * when one note changes.
 */
export const NoteRow = memo(function NoteRow(props: RowProps) {
  const { note: n, events, highlight } = props
  const id = n.id
  const ref = useCallback((el: HTMLLIElement | null) => events.setRow(id, el), [events, id])
  const chips = n.tagIds.flatMap((tagId) => {
    const tag = props.tags.get(tagId)
    return tag ? [tag] : []
  })
  const progress = parseProgress(props.progress)
  const excerpt = n.excerpt ?? props.preview ?? ''
  return (
    <li
      ref={ref}
      className="row"
      data-note-id={id}
      role="option"
      aria-selected={props.selected}
      aria-posinset={props.position}
      aria-setsize={props.setSize}
      tabIndex={props.tabbable ? 0 : -1}
      onMouseDown={events.mouseDown}
      onClick={(e) => events.click(id, e)}
      draggable={props.draggable}
      onDragStart={(e) => events.dragStart(id, e)}
      onKeyDown={(e) => events.keyDown(id, e)}
      onContextMenu={props.menu ? (e) => events.contextMenu(id, e) : undefined}
    >
      {n.title ? (
        <span className="row-title">
          <Marked text={n.title} pattern={highlight?.title} />
        </span>
      ) : null}
      <span className="row-meta">
        <time
          className="row-time"
          dateTime={new Date(n.updatedAt).toISOString()}
          title={fullDate(n.updatedAt, props.locale)}
        >
          {relativeTime(n.updatedAt, props.now, props.locale)}
        </time>
        {n.status !== 'none' ? (
          <span
            className={`row-status status-${n.status}`}
            role="img"
            aria-label={t(`status.${n.status}`)}
            title={t(`status.${n.status}`)}
          >
            <Icon name={STATUS_ICONS[n.status]} size="sm" />
          </span>
        ) : null}
        {progress ? <TaskProgress {...progress} /> : null}
        {chips.map((c) => (
          <span key={c.id} className={chipClass(c.color)}>
            {c.color ? <TagDot color={c.color} /> : null}
            {c.name}
          </span>
        ))}
      </span>
      {n.title ? (
        excerpt ? (
          <span className="row-excerpt">
            <Marked text={excerpt} pattern={highlight?.body} />
          </span>
        ) : null
      ) : (
        <span className="row-excerpt">
          {/* An untitled note: its first line (or Untitled, for one with no text) leads. */}
          <span className="row-headline">{props.headline ?? t('note.untitled')}</span>
          {excerpt ? (
            <>
              {' '}
              <Marked text={excerpt} pattern={highlight?.body} />
            </>
          ) : null}
        </span>
      )}
    </li>
  )
})
