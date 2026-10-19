import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { NoteSummary, TaskProgress } from '../../../core'
import { errorCode } from '../../../core/errors'
import type { Core } from '../core-client'
import { displayTitles } from '../headlines'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import type { IconName } from '../icons/symbols'
import { expand } from '../resizeMotion'
import {
  backlinksOpen,
  dateInputValue,
  datesEdit,
  infoFields,
  parseDateInput,
  setBacklinksOpen,
  type InfoField,
  type NoteInfoData,
} from './infoCard'

function Field(props: { icon: IconName; label: string; children: ReactNode }) {
  return (
    <div className="note-info-field">
      <span className="note-info-icon">
        <Icon name={props.icon} size="lg" />
      </span>
      <span className="note-info-caption">
        <span className="note-info-label">{props.label}</span>
        <span className="note-info-value">{props.children}</span>
      </span>
    </div>
  )
}

/** The dates a note's info card writes (see NoteService.setDates). */
export type SetNoteDates = (
  noteId: string,
  dates: { createdAt?: number; updatedAt?: number },
) => Promise<void>

/** How a date edit ended: written, turned down (the dates would be out of order), or not written. */
export type DateOutcome = 'saved' | 'refused' | 'failed'

/**
 * A date of the card. With `onSet` a click opens a date-time field: Return
 * saves it, Escape (or leaving the field) puts the date back. A date that is
 * not saved keeps the field open and says why.
 */
export function DateValue(props: {
  field: InfoField
  at: number
  onSet?: ((at: number) => Promise<DateOutcome>) | undefined
}) {
  const { field, at, onSet } = props
  const [editing, setEditing] = useState(false)
  const [problem, setProblem] = useState<MessageKey>()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) input.current?.focus()
  }, [editing])
  const time = (
    <time data-info={field.key} dateTime={field.dateTime}>
      {field.value}
    </time>
  )
  if (!onSet) return time
  if (!editing) {
    return (
      <button
        type="button"
        className="note-info-date"
        title={t('noteInfo.editDate')}
        aria-label={format(t('noteInfo.editDateNamed'), { field: field.label, date: field.value })}
        onClick={() => setEditing(true)}
      >
        {time}
      </button>
    )
  }
  const problemId = `note-info-${field.key}-problem`
  return (
    <span className="note-info-date-edit">
      <input
        ref={input}
        type="datetime-local"
        step={1}
        className="note-info-date-input"
        aria-label={field.label}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? problemId : undefined}
        data-info-edit={field.key}
        defaultValue={dateInputValue(at)}
        onBlur={() => setEditing(false)}
        onChange={() => setProblem(undefined)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setEditing(false)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            const next = parseDateInput(event.currentTarget.value)
            if (next === null) return setProblem('noteInfo.dateIncomplete')
            void onSet(next).then((outcome) => {
              if (outcome === 'saved') setEditing(false)
              else if (outcome === 'failed') setProblem('noteInfo.dateFailed')
              else
                setProblem(
                  field.key === 'created' ? 'noteInfo.createdTooLate' : 'noteInfo.updatedTooEarly',
                )
            })
          }
        }}
      />
      {problem ? (
        <span id={problemId} className="note-info-date-problem" role="alert">
          {t(problem)}
        </span>
      ) : null}
    </span>
  )
}

interface Backlink {
  id: string
  name: string
}

/**
 * The preview's first element (never part of an exported or printed page):
 * the note's task progress and dates, then the notes that link to it.
 */
export function NoteInfo(props: {
  core: Core
  info: NoteInfoData
  tasks: TaskProgress
  onOpenNote: (id: string) => void
  /** Writes dates set on the card; without it the dates cannot be changed. */
  onSetDates?: SetNoteDates | undefined
}) {
  const { core, info, tasks, onOpenNote, onSetDates } = props
  /** Writes field `key` as `at`; anything but 'saved' keeps the field open to fix. */
  const setDate = (key: 'created' | 'updated', at: number): Promise<DateOutcome> => {
    if (!onSetDates) return Promise.resolve('failed')
    const dates = datesEdit(info, key, at)
    if (!dates) return Promise.resolve('refused')
    return onSetDates(info.noteId, dates).then(
      (): DateOutcome => 'saved',
      (): DateOutcome => {
        console.warn('W_NOTE_DATES_FAILED', info.noteId)
        return 'failed'
      },
    )
  }
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [open, setOpen] = useState(backlinksOpen)

  useEffect(() => {
    let current = true
    core
      .backlinks(info.noteId)
      .then(async (notes: NoteSummary[]) => {
        const names = await displayTitles((ids) => core.headlines(ids), notes)
        if (current) setBacklinks(notes.map((n) => ({ id: n.id, name: names.get(n.id) ?? '' })))
      })
      .catch((e: unknown) => console.warn('W_BACKLINKS_FAILED', info.noteId, errorCode(e)))
    return () => {
      current = false
    }
  }, [core, info.noteId])

  return (
    <div className="note-info" data-find-skip="">
      <div className="note-info-card" role="group" aria-label={t('noteInfo.label')}>
        {infoFields(info, tasks, currentLocale()).map((field) => (
          <Field key={field.key} icon={field.icon} label={field.label}>
            {field.tasks ? (
              <>
                <progress className="task-bar" value={field.tasks.done} max={field.tasks.total} />
                <span data-info={field.key}>{field.value}</span>
              </>
            ) : (
              <DateValue
                field={field}
                at={field.key === 'created' ? info.createdAt : info.updatedAt}
                onSet={
                  onSetDates && field.key !== 'progress'
                    ? (at) => setDate(field.key as 'created' | 'updated', at)
                    : undefined
                }
              />
            )}
          </Field>
        ))}
      </div>
      {backlinks.length > 0 ? (
        <details
          className="note-backlinks"
          open={open}
          onToggle={(event) => {
            const now = event.currentTarget.open
            // Opened by the user (not shown open): the list grows in.
            const list = event.currentTarget.querySelector('ul')
            if (now && !open && list) expand(list)
            setOpen(now)
            setBacklinksOpen(now)
          }}
        >
          <summary>{t('noteInfo.backlinks')}</summary>
          <ul>
            {backlinks.map((note) => (
              <li key={note.id}>
                <button type="button" className="note-backlink" onClick={() => onOpenNote(note.id)}>
                  <Icon name="backlink" size="sm" />
                  <span>{note.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}
