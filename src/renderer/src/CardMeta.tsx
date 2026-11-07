import type { NoteSummary, TagRecord, TaskProgress } from '../../core'
import type { ListDatesStyle } from '../../core/editorSettings'
import { compareNames } from '../../core/sort'
import type { WriterRef } from './authorshipLabels'
import { fullDate, rowDate } from './format'
import { format, t } from './i18n'
import { Icon } from './icons/Icon'
import { ChangedBy, STATUS_ICONS } from './NoteRow'
import { tagColorStyle, tagDotClass } from './tagColorStyle'

export interface CardMetaProps {
  note: NoteSummary
  tags: ReadonlyMap<string, TagRecord>
  now: number
  locale: string
  dates: ListDatesStyle
  changedBy: WriterRef | undefined
  /** Undefined until the note's counts are read. */
  tasks?: TaskProgress | undefined
  /** Lead with the pin and the status mark, as a gallery caption does; a board's column already says the status. */
  marks: boolean
}

/** The meta row of a board card and of a gallery card's caption: when the note changed, its task progress, then its tags as dots at the row's end. */
export function CardMeta(props: CardMetaProps) {
  const { note: n } = props
  // By name, as the note header lists them; the note stores them in its query's order.
  const tags = n.tagIds
    .flatMap((tagId) => {
      const tag = props.tags.get(tagId)
      return tag ? [tag] : []
    })
    .sort((a, b) => compareNames(a.name, b.name, props.locale))
  return (
    <span className="card-meta">
      {props.marks && n.pinned ? (
        <span className="card-pin" role="img" aria-label={t('noteList.pinned')}>
          <Icon name="notes.pinned" size="sm" />
        </span>
      ) : null}
      {props.marks && n.status !== 'none' ? (
        <span
          className={`card-status status-${n.status}`}
          role="img"
          aria-label={t(`status.${n.status}`)}
          title={t(`status.${n.status}`)}
        >
          <Icon name={STATUS_ICONS[n.status]} size="sm" />
        </span>
      ) : null}
      <time
        className="card-time"
        dateTime={new Date(n.updatedAt).toISOString()}
        title={fullDate(n.updatedAt, props.locale)}
      >
        {rowDate(n.updatedAt, props.now, props.locale, props.dates)}
      </time>
      {props.changedBy ? <ChangedBy writer={props.changedBy} compact /> : null}
      {props.tasks && props.tasks.total > 0 ? <TaskRing {...props.tasks} /> : null}
      {tags.length > 0 ? (
        <span className="card-tags">
          {tags.map((tag) => (
            <span
              key={tag.id}
              className={tagDotClass(tag.color)}
              style={tagColorStyle(tag.color)}
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
  )
}

const RING_RADIUS = 4.5
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

function TaskRing({ done, total }: TaskProgress) {
  const values = { done: String(done), total: String(total) }
  return (
    <span
      className={done >= total ? 'card-tasks card-tasks-done' : 'card-tasks'}
      role="img"
      aria-label={format(t('noteList.progressLabel'), values)}
    >
      <svg className="card-tasks-ring" viewBox="0 0 12 12" aria-hidden>
        <circle className="card-tasks-track" cx="6" cy="6" r={RING_RADIUS} />
        {done > 0 ? (
          <circle
            className="card-tasks-arc"
            cx="6"
            cy="6"
            r={RING_RADIUS}
            strokeDasharray={`${(RING_LENGTH * Math.min(done, total)) / total} ${RING_LENGTH}`}
            transform="rotate(-90 6 6)"
          />
        ) : null}
      </svg>
      <span aria-hidden>{format(t('board.cardTasks'), values)}</span>
    </span>
  )
}
