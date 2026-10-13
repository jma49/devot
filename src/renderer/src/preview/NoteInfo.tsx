import { useEffect, useState, type ReactNode } from 'react'
import type { NoteSummary, TaskProgress } from '../../../core'
import type { Core } from '../core-client'
import { displayTitles } from '../headlines'
import { currentLocale, t } from '../i18n'
import { Icon } from '../icons/Icon'
import type { IconName } from '../icons/symbols'
import { backlinksOpen, infoFields, setBacklinksOpen, type NoteInfoData } from './infoCard'

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
}) {
  const { core, info, tasks, onOpenNote } = props
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
      .catch(() => console.warn('W_BACKLINKS_FAILED', info.noteId))
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
              <time data-info={field.key} dateTime={field.dateTime}>
                {field.value}
              </time>
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
