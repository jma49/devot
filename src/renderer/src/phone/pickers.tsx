import type { BookRecord, NoteStatus, NoteSummary, TagRecord } from '../../../core/storage'
import { t, type MessageKey } from '../i18n'
import { PhoneSheet, SheetChoice } from './PhoneSheet'

export const STATUS_LABEL: Readonly<Record<NoteStatus, MessageKey>> = {
  none: 'status.none',
  active: 'status.active',
  on_hold: 'status.on_hold',
  completed: 'status.completed',
  dropped: 'status.dropped',
}

export const statusMark = (status: NoteStatus): string =>
  status === 'none'
    ? 'var(--color-phone-status-none)'
    : `var(--color-status-${status === 'on_hold' ? 'hold' : status === 'completed' ? 'done' : status}-mark)`

export const statusTile = (status: NoteStatus): string =>
  `var(--color-phone-status-tile-${
    status === 'on_hold' ? 'hold' : status === 'completed' ? 'done' : status
  })`

export function StatusMark(props: { status: NoteStatus }) {
  return (
    <span
      aria-hidden="true"
      className="phone-status-ring"
      data-filled={props.status === 'completed' || undefined}
      style={{ color: statusMark(props.status) }}
    />
  )
}

export function NotebookPicker(props: {
  books: readonly BookRecord[]
  current: string | null
  onPick: (bookId: string | null) => void
  onClose: () => void
}) {
  const live = props.books.filter((b) => b.deletedAt === null)
  return (
    <PhoneSheet title={t('phone.moveTo')} onClose={props.onClose}>
      <ul className="phone-card">
        <SheetChoice
          label={t('phone.noNotebook')}
          selected={props.current === null}
          onPick={() => props.onPick(null)}
        />
        {live.map((book) => (
          <SheetChoice
            key={book.id}
            label={book.name}
            selected={props.current === book.id}
            onPick={() => props.onPick(book.id)}
          />
        ))}
      </ul>
    </PhoneSheet>
  )
}

export function StatusPicker(props: {
  current: NoteStatus
  onPick: (status: NoteStatus) => void
  onClose: () => void
}) {
  return (
    <PhoneSheet title={t('phone.status')} onClose={props.onClose}>
      <ul className="phone-card">
        {(Object.keys(STATUS_LABEL) as NoteStatus[]).map((status) => (
          <SheetChoice
            key={status}
            label={t(STATUS_LABEL[status])}
            selected={props.current === status}
            lead={<StatusMark status={status} />}
            onPick={() => props.onPick(status)}
          />
        ))}
      </ul>
    </PhoneSheet>
  )
}

export function TagPicker(props: {
  note: NoteSummary
  tags: readonly TagRecord[]
  onToggle: (tag: TagRecord, on: boolean) => void
  onClose: () => void
}) {
  const live = props.tags.filter((tag) => tag.deletedAt === null)
  return (
    <PhoneSheet title={t('sidebar.tags')} onClose={props.onClose}>
      {live.length === 0 ? (
        <p className="phone-sheet-empty">{t('phone.noTags')}</p>
      ) : (
        <ul className="phone-card">
          {live.map((tag) => {
            const on = props.note.tagIds.includes(tag.id)
            return (
              <SheetChoice
                key={tag.id}
                label={tag.name}
                selected={on}
                lead={
                  <span
                    aria-hidden="true"
                    className="phone-tag-dot"
                    style={{
                      background: tag.color
                        ? `var(--color-tag-${tag.color})`
                        : 'var(--color-phone-status-none)',
                    }}
                  />
                }
                onPick={() => props.onToggle(tag, !on)}
              />
            )
          })}
        </ul>
      )}
    </PhoneSheet>
  )
}
