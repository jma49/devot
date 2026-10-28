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
import type { ListDatesStyle } from '../../core/editorSettings'
import type { StripDay } from '../../core/activity'
import { ActivityStrip } from './ActivityStrip'
import { writerLabelParts, type WriterRef } from './authorshipLabels'
import { fullDate, rowDate } from './format'
import { format, t } from './i18n'
import { Icon } from './icons/Icon'
import type { IconName } from './icons/symbols'
import { chipClass, TagDot } from './TagEditor'
import { WriterLabel } from './WriterLabel'

export const STATUS_ICONS: Readonly<Record<NoteStatus, IconName>> = {
  none: 'status.none',
  active: 'status.active',
  on_hold: 'status.onHold',
  completed: 'status.completed',
  dropped: 'status.dropped',
}

export function Marked({ text, pattern }: { text: string; pattern: RegExp | null | undefined }) {
  if (!pattern) return text
  return matchSegments(text, pattern).map((s, i) =>
    s.match ? <mark key={i}>{s.text}</mark> : <Fragment key={i}>{s.text}</Fragment>,
  )
}

export function parseProgress(
  text: string | undefined,
): { done: number; total: number } | undefined {
  const m = text ? /^(\d+)\/(\d+)$/.exec(text) : null
  if (!m) return undefined
  const done = Number(m[1])
  const total = Number(m[2])
  return total > 0 && done <= total ? { done, total } : undefined
}

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
        <span className="progress-fill" style={{ transform: `scaleX(${done / total})` }} />
      </span>
      <span className="progress-text" aria-hidden="true">
        {format(t('noteList.progress'), values)}
      </span>
    </span>
  )
}

/** A note agents changed since the owner last looked: a mark, and who changed it last. */
export function ChangedBy({ writer, compact }: { writer: WriterRef; compact?: boolean }) {
  const template = t('authorship.changedBy')
  return (
    <span
      className="row-agent"
      title={compact ? writerLabelParts(writer, template).full : undefined}
    >
      <span className="row-agent-mark" aria-hidden="true" />
      {compact ? (
        <span className="visually-hidden">{writerLabelParts(writer, template).full}</span>
      ) : (
        <WriterLabel writer={writer} template={template} />
      )}
    </span>
  )
}

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
  open: boolean
  tabbable: boolean
  tags: ReadonlyMap<string, TagRecord>
  highlight: { title: RegExp | null; body: RegExp | null } | undefined
  headline: string | undefined
  preview: string | undefined
  progress: string | undefined
  /** The note's activity strip; none while it is hidden or not read yet. */
  strip?: readonly StripDay[] | undefined
  /** The newest writer of the note's unseen agent writes (ADR 0007), as the UI names it. */
  changedBy?: WriterRef | undefined
  now: number
  locale: string
  dates: ListDatesStyle
  draggable: boolean
  dragging: boolean
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
      data-open={props.open || undefined}
      aria-posinset={props.position}
      aria-setsize={props.setSize}
      tabIndex={props.tabbable ? 0 : -1}
      onMouseDown={events.mouseDown}
      onClick={(e) => events.click(id, e)}
      draggable={props.draggable}
      data-dragging={props.dragging || undefined}
      onDragStart={(e) => events.dragStart(id, e)}
      onKeyDown={(e) => events.keyDown(id, e)}
      onContextMenu={props.menu ? (e) => events.contextMenu(id, e) : undefined}
    >
      {n.title ? (
        <span className="row-title" dir="auto">
          <Marked text={n.title} pattern={highlight?.title} />
        </span>
      ) : null}
      <span className="row-meta">
        <time
          className="row-time"
          dateTime={new Date(n.updatedAt).toISOString()}
          title={fullDate(n.updatedAt, props.locale)}
        >
          {rowDate(n.updatedAt, props.now, props.locale, props.dates)}
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
          <span key={c.id} className={chipClass(c.color)} dir="auto">
            {c.color ? <TagDot color={c.color} /> : null}
            {c.name}
          </span>
        ))}
        {props.changedBy ? <ChangedBy writer={props.changedBy} /> : null}
        {props.strip ? (
          <ActivityStrip days={props.strip} now={props.now} locale={props.locale} />
        ) : null}
      </span>
      {n.title ? (
        excerpt ? (
          <span className="row-excerpt" dir="auto">
            <Marked text={excerpt} pattern={highlight?.body} />
          </span>
        ) : null
      ) : (
        <span className="row-excerpt" dir="auto">
          <span className="row-headline" dir="auto">
            {props.headline ?? t('note.untitled')}
          </span>
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
