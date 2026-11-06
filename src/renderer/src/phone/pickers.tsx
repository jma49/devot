import { useState } from 'react'
import type {
  BookRecord,
  NoteStatus,
  NoteSummary,
  TagColorValue,
  TagRecord,
} from '../../../core/storage'
import { isCustomTagColor, MAX_TAG_NAME_CHARS } from '../../../core/tags'
import { trimWhitespace } from '../../../core/text'
import { ColorPicker } from '../ColorPicker'
import { ColorSwatches } from '../ColorSwatches'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { useNameLimit } from '../nameLimit'
import { quickTagRows, readRecentTags, rememberTag } from '../quickTag'
import { localStore } from '../localStore'
import { Icon } from '../icons/Icon'
import { tagColorClass, tagColorStyle } from '../tagColorStyle'
import type { IconName } from '../icons/symbols'
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

const STATUS_SYMBOL: Readonly<Record<NoteStatus, IconName>> = {
  none: 'phone.status.none',
  active: 'phone.status.active',
  on_hold: 'phone.status.onHold',
  completed: 'phone.status.completed',
  dropped: 'phone.status.dropped',
}

export function StatusMark(props: { status: NoteStatus }) {
  return (
    <span
      aria-hidden="true"
      className="phone-status-mark"
      data-status={props.status}
      style={{ color: statusMark(props.status) }}
    >
      <Icon name={STATUS_SYMBOL[props.status]} size="phone-status" />
    </span>
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
  counts: ReadonlyMap<string, number>
  onToggle: (tag: TagRecord, on: boolean) => void
  onCreate: (name: string, color: TagColorValue | null) => void
  onClose: () => void
}) {
  const live = props.tags.filter((tag) => tag.deletedAt === null)
  const [draft, setDraft] = useState('')
  const [color, setColor] = useState<TagColorValue | null>(null)
  const [picking, setPicking] = useState(false)
  const [recent, setRecent] = useState(() => readRecentTags(localStore()))
  const limit = useNameLimit(draft, MAX_TAG_NAME_CHARS, setDraft)
  const text = trimWhitespace(draft)
  // The note's own tags stay listed, so a tap can take one off.
  const rows = quickTagRows(live, [], draft, recent)
  const creating = rows.at(-1)?.kind === 'create'
  const toggle = (tag: TagRecord, on: boolean) => {
    if (on) {
      rememberTag(localStore(), tag.id)
      setRecent(readRecentTags(localStore()))
    }
    props.onToggle(tag, on)
  }
  return (
    <PhoneSheet title={t('sidebar.tags')} onClose={props.onClose}>
      {picking ? (
        <ColorPicker
          value={isCustomTagColor(color) ? color : null}
          tagName={text}
          onDone={(hex) => {
            setColor(hex)
            setPicking(false)
          }}
          onCancel={() => setPicking(false)}
        />
      ) : (
        <>
          <input
            className="phone-tag-field"
            type="text"
            aria-label={t('quickTag.field')}
            placeholder={t('quickTag.placeholder')}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={draft}
            {...limit}
          />
          {rows.length === 0 ? (
            <p className="phone-sheet-empty">{t('phone.noTags')}</p>
          ) : (
            <ul className="phone-card">
              {rows.map((row) => {
                if (row.kind === 'create') {
                  return (
                    <SheetChoice
                      key="create"
                      label={format(t('note.createTag'), { name: row.name })}
                      onPick={() => {
                        props.onCreate(row.name, color)
                        setDraft('')
                        setColor(null)
                      }}
                    />
                  )
                }
                const { tag } = row
                const on = props.note.tagIds.includes(tag.id)
                return (
                  <SheetChoice
                    key={tag.id}
                    label={tag.name}
                    selected={on}
                    value={(props.counts.get(tag.id) ?? 0).toLocaleString(currentLocale())}
                    lead={
                      <span
                        aria-hidden="true"
                        className={`phone-tag-dot ${tagColorClass(tag.color)}`}
                        style={tagColorStyle(tag.color)}
                      />
                    }
                    onPick={() => toggle(tag, !on)}
                  />
                )
              })}
            </ul>
          )}
          {creating ? (
            <ColorSwatches
              value={color}
              onChange={setColor}
              label={t('tagMenu.color')}
              noneLabel={t('tagColor.none')}
              onCustom={() => setPicking(true)}
            />
          ) : null}
        </>
      )}
    </PhoneSheet>
  )
}
