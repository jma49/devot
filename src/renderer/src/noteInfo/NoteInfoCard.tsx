import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { NoteFacts } from '../../../core/noteFacts'
import type { PropertyRow } from '../../../core/preview/frontMatterView'
import { closingRef } from '../closing'
import { exactDate, formatNumber, fullDate, taskCount } from '../format'
import { currentLocale, format, t } from '../i18n'
import { Icon } from '../icons/Icon'
import type { IconName } from '../icons/symbols'
import { frontMatterChange, type FrontMatterChange } from '../preview/frontMatterApply'
import { tagColorClass, tagColorStyle } from '../tagColorStyle'
import { DatePicker, type DateOutcome } from './DatePicker'
import type { DateField } from './calendar'
import {
  datesEdit,
  sectionOpen,
  setSectionOpen,
  type InfoSection,
  type NoteInfoData,
} from './infoCard'

export type SetNoteDates = (
  noteId: string,
  dates: { createdAt?: number; updatedAt?: number },
) => Promise<void>

export interface Backlink {
  id: string
  name: string
}

/** A note that names this one in its text without linking to it, and the line it does so on. */
export interface UnlinkedMention extends Backlink {
  excerpt: string
}

const cardRef = closingRef('scale', 'note-info-card')

/** A save's answer closes the picker only while that same save is still the one it waits on. */
type Picker =
  | { kind: 'closed' }
  | { kind: 'open'; field: DateField; pendingAt: number | null }
  | { kind: 'saving'; field: DateField; pendingAt: number | null; save: number }

const CLOSED: Picker = { kind: 'closed' }

const shownPicker = (card: HTMLElement | null) =>
  card?.querySelector<HTMLElement>(':scope > .date-picker:not([data-closing])') ?? null

function Row(props: {
  icon?: IconName | undefined
  label: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`note-info-row${props.className ? ` ${props.className}` : ''}`}>
      <span className="note-info-icon">
        {props.icon ? <Icon name={props.icon} size="sm" /> : null}
      </span>
      <span className="note-info-label">{props.label}</span>
      <span className="note-info-value">{props.children}</span>
    </div>
  )
}

function Section(props: {
  section: InfoSection
  title: string
  count: number
  children: ReactNode
}) {
  const [open, setOpen] = useState(() => sectionOpen(props.section))
  const id = `note-info-${props.section}`
  return (
    <section className="note-info-section" data-open={open || undefined}>
      <button
        type="button"
        className="note-info-caption"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open)
          setSectionOpen(props.section, !open)
        }}
      >
        <span>{props.title}</span>
        <span className="note-info-count">{formatNumber(props.count, currentLocale())}</span>
        <Icon name="disclosure.open" size="xs" className="note-info-chevron" />
      </button>
      {open ? (
        <div id={id} className="note-info-fold">
          {props.children}
        </div>
      ) : null}
    </section>
  )
}

function PropertyValue(props: {
  row: PropertyRow
  onApply?: ((change: FrontMatterChange) => void) | undefined
}) {
  const { value, difference } = props.row
  const names = {
    title: t('preview.applyTitle'),
    status: t('preview.applyStatus'),
    tags: t('preview.applyTags'),
  }
  return (
    <>
      {value.kind === 'chips'
        ? value.chips.map((chip, i) => (
            <span
              key={i}
              className={
                chip.color
                  ? `frontmatter-chip tag-chip ${tagColorClass(chip.color)}`
                  : 'frontmatter-chip'
              }
              style={tagColorStyle(chip.color)}
            >
              {chip.name}
            </span>
          ))
        : value.text}
      {difference ? (
        <span className="frontmatter-note">
          <span className="frontmatter-badge" title={difference.badge}>
            {difference.badge}
          </span>
          {difference.value !== null && props.onApply ? (
            <button
              type="button"
              className="frontmatter-apply"
              aria-label={names[difference.field]}
              onClick={() => {
                const change = frontMatterChange(difference.field, difference.value)
                if (change) props.onApply?.(change)
              }}
            >
              {t('preview.frontMatterApply')}
            </button>
          ) : null}
        </span>
      ) : null}
    </>
  )
}

/**
 * The open note's Note Info: when it was created and updated (set from a date picker), its
 * front matter, the notes that link to it, and its tasks and words. Escape closes it.
 */
export function NoteInfoCard(props: {
  info: NoteInfoData
  facts: NoteFacts | undefined
  backlinks: readonly Backlink[] | undefined
  mentions: readonly UnlinkedMention[] | undefined
  onOpenNote: (id: string) => void
  /** Makes a note's mention of this one a link; without it (read-only) mentions are only listed. */
  onLinkMention?: ((id: string) => void) | undefined
  onSetDates?: SetNoteDates | undefined
  onApplyFrontMatter?: ((change: FrontMatterChange) => void) | undefined
  onClose: () => void
}) {
  const { info, facts, backlinks, mentions, onOpenNote, onLinkMention } = props
  const { onSetDates, onApplyFrontMatter, onClose } = props
  const locale = currentLocale()
  const card = useRef<HTMLDivElement>(null)
  const rows = useRef<Partial<Record<DateField, HTMLButtonElement | null>>>({})
  const setCard = useCallback((el: HTMLDivElement | null) => {
    card.current = el
    return cardRef(el)
  }, [])
  const [picker, setPicker] = useState<Picker>(CLOSED)
  const pickerNow = useRef(picker)
  const saves = useRef(0)
  const move = useCallback((next: (now: Picker) => Picker) => {
    pickerNow.current = next(pickerNow.current)
    setPicker(pickerNow.current)
  }, [])
  const editing = picker.kind === 'closed' ? undefined : picker.field

  const closePicker = useCallback(
    (field: DateField) => {
      move(() => CLOSED)
      rows.current[field]?.focus()
    },
    [move],
  )
  const setPendingAt = useCallback(
    (pendingAt: number | null) =>
      move((now) => (now.kind === 'closed' ? now : { ...now, pendingAt })),
    [move],
  )

  useLayoutEffect(() => {
    if (!editing) return
    const row = rows.current[editing]
    const panel = shownPicker(card.current)
    if (!row || !card.current || !panel) return
    const box = card.current.getBoundingClientRect()
    const anchor = row.getBoundingClientRect()
    const below = anchor.bottom + panel.offsetHeight < window.innerHeight
    panel.dataset['side'] = below ? 'below' : 'above'
    panel.style.top = below
      ? `${anchor.bottom - box.top}px`
      : `${anchor.top - box.top - panel.offsetHeight}px`
    panel.style.left = `${anchor.left - box.left}px`
  }, [editing])

  useLayoutEffect(() => {
    const away = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (editing) {
        // The open picker's own row closes it on its click.
        const inside = [shownPicker(card.current), rows.current[editing]]
        if (!inside.some((el) => el?.contains(target))) closePicker(editing)
        return
      }
      const anchor = card.current?.parentElement
      if (!anchor?.contains(target)) onClose()
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [editing, closePicker, onClose])

  const setDate = (field: DateField, at: number): Promise<DateOutcome> => {
    if (!onSetDates) return Promise.resolve('failed')
    const dates = datesEdit(info, field, at)
    if (!dates) return Promise.resolve('refused')
    const save = ++saves.current
    move((now) => (now.kind === 'closed' ? now : { ...now, kind: 'saving', save }))
    const waiting = () => {
      const now = pickerNow.current
      return now.kind === 'saving' && now.field === field && now.save === save
    }
    return onSetDates(info.noteId, dates).then(
      (): DateOutcome => {
        if (waiting()) closePicker(field)
        return 'saved'
      },
      (): DateOutcome => {
        console.warn('W_NOTE_DATES_FAILED', info.noteId)
        if (waiting()) move((now) => (now.kind === 'saving' ? { ...now, kind: 'open' } : now))
        return 'failed'
      },
    )
  }

  const dateRow = (field: DateField, icon: IconName, at: number) => {
    const label = t(field === 'created' ? 'noteInfo.created' : 'noteInfo.updated')
    const pendingAt = picker.kind !== 'closed' && picker.field === field ? picker.pendingAt : null
    const shown = pendingAt ?? at
    const value = fullDate(shown, locale)
    const time = (
      <time dateTime={new Date(shown).toISOString()} data-info={field}>
        {value}
      </time>
    )
    if (!onSetDates) {
      return (
        <div className="note-info-row" title={exactDate(at, locale)}>
          <span className="note-info-icon">
            <Icon name={icon} size="sm" />
          </span>
          <span className="note-info-label">{label}</span>
          <span className="note-info-value">{time}</span>
        </div>
      )
    }
    return (
      <button
        ref={(el) => {
          rows.current[field] = el
        }}
        type="button"
        className="note-info-row note-info-date"
        title={exactDate(at, locale)}
        aria-label={format(t('noteInfo.editDateNamed'), {
          field: label,
          date: fullDate(at, locale),
        })}
        aria-haspopup="dialog"
        aria-expanded={editing === field}
        data-editing={editing === field || undefined}
        onClick={() =>
          move(() => (editing === field ? CLOSED : { kind: 'open', field, pendingAt: null }))
        }
      >
        <span className="note-info-icon">
          <Icon name={icon} size="sm" />
        </span>
        <span className="note-info-label">{label}</span>
        <span className="note-info-value">{time}</span>
      </button>
    )
  }

  const front = facts?.frontMatter ?? null
  const tasks = facts?.tasks
  return (
    <div
      ref={setCard}
      className="note-info-card"
      role="dialog"
      aria-label={t('noteInfo.label')}
      tabIndex={-1}
      data-find-skip=""
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      <div className="note-info-scroll">
        <div className="note-info-dates">
          {dateRow('created', 'date.created', info.createdAt)}
          {dateRow('updated', 'date.updated', info.updatedAt)}
        </div>
        {front ? (
          <Section
            section="properties"
            title={t('noteInfo.properties')}
            count={front.kind === 'properties' ? front.rows.length : 1}
          >
            {front.kind === 'properties' ? (
              <dl className="note-info-properties">
                {front.rows.map((row, i) => (
                  <div key={i} className="note-info-row note-info-property">
                    <span className="note-info-icon" />
                    <dt className="note-info-label" title={row.key}>
                      {row.key}
                    </dt>
                    <dd className="note-info-value">
                      <PropertyValue row={row} onApply={onApplyFrontMatter} />
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <pre className="note-info-yaml">
                <code>{front.yaml}</code>
              </pre>
            )}
          </Section>
        ) : null}
        <Section section="backlinks" title={t('noteInfo.backlinks')} count={backlinks?.length ?? 0}>
          {backlinks && backlinks.length > 0 ? (
            <ul className="note-info-links">
              {backlinks.map((note) => (
                <li key={note.id}>
                  <button
                    type="button"
                    className="note-info-row note-info-link"
                    onClick={() => {
                      onClose()
                      onOpenNote(note.id)
                    }}
                  >
                    <span className="note-info-icon">
                      <Icon name="backlink" size="sm" />
                    </span>
                    <span className="note-info-value">{note.name || t('note.untitled')}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="note-info-empty">{t('noteInfo.noBacklinks')}</p>
          )}
        </Section>
        <Section section="mentions" title={t('noteInfo.mentions')} count={mentions?.length ?? 0}>
          {mentions && mentions.length > 0 ? (
            <ul className="note-info-links">
              {mentions.map((note) => {
                const name = note.name || t('note.untitled')
                return (
                  <li key={note.id} className="note-info-mention">
                    <button
                      type="button"
                      className="note-info-row note-info-link"
                      onClick={() => {
                        onClose()
                        onOpenNote(note.id)
                      }}
                    >
                      <span className="note-info-icon">
                        <Icon name="backlink" size="sm" />
                      </span>
                      <span className="note-info-value">
                        {name}
                        <span className="note-info-excerpt">{note.excerpt}</span>
                      </span>
                    </button>
                    {onLinkMention ? (
                      <button
                        type="button"
                        className="frontmatter-apply note-info-mention-link"
                        aria-label={format(t('noteInfo.linkMentionIn'), { note: name })}
                        onClick={() => onLinkMention(note.id)}
                      >
                        {t('noteInfo.linkMention')}
                      </button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="note-info-empty">
              {mentions ? t('noteInfo.noMentions') : t('noteInfo.findingMentions')}
            </p>
          )}
        </Section>
      </div>
      <div className="note-info-foot">
        {tasks && tasks.total > 0 ? (
          <Row icon="progress" label={t('noteInfo.tasks')} className="note-info-meter">
            <progress
              className="note-info-meter-bar"
              value={tasks.done}
              max={tasks.total}
              aria-label={taskCount(tasks.done, tasks.total, locale)}
            />
            <span>
              {format(t('noteInfo.summaryTasks'), {
                done: formatNumber(tasks.done, locale),
                total: formatNumber(tasks.total, locale),
              })}
            </span>
          </Row>
        ) : null}
        <Row icon="settings.markdown" label={t('noteInfo.words')}>
          {facts ? formatNumber(facts.words, locale) : null}
        </Row>
      </div>
      {editing ? (
        <DatePicker
          key={editing}
          field={editing}
          label={t(editing === 'created' ? 'noteInfo.created' : 'noteInfo.updated')}
          at={editing === 'created' ? info.createdAt : info.updatedAt}
          info={info}
          locale={locale}
          onPending={setPendingAt}
          onCancel={() => closePicker(editing)}
          onSet={(at) => setDate(editing, at)}
        />
      ) : null}
    </div>
  )
}
