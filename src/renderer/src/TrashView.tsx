import { useEffect, useState } from 'react'
import type { Core } from './core-client'
import { headline } from '../../core/extract'
import { displayTitle } from './headlines'
import { t } from './i18n'
import { Preview } from './preview/Preview'

export function TrashView(props: {
  core: Core
  noteId: string
  onRestore: () => void
  onDelete: (title: string) => void
  readOnly?: boolean
}) {
  const { core, noteId } = props
  const [note, setNote] = useState<{
    title: string
    bodyMd: string
    createdAt: number
    updatedAt: number
  }>()
  useEffect(() => {
    let current = true
    core.peekTrashed(noteId).then(
      (n) => current && setNote(n),
      () => console.warn('W_TRASH_PEEK_FAILED', noteId),
    )
    return () => {
      current = false
    }
  }, [core, noteId])
  if (!note) return null
  const name = displayTitle(note.title, headline(note.bodyMd))
  return (
    <>
      <div className="trash-banner" role="status">
        <span>{t('trash.banner')}</span>
        <button
          type="button"
          className="button"
          disabled={props.readOnly}
          onClick={props.onRestore}
        >
          {t('trash.restore')}
        </button>
        <button
          type="button"
          className="button button-destructive"
          disabled={props.readOnly}
          onClick={() => props.onDelete(name)}
        >
          {t('trash.deleteForever')}
        </button>
      </div>
      <h1 className="title trash-title">{name}</h1>
      <div className="panes panes-preview">
        <Preview
          core={core}
          markdown={note.bodyMd}
          info={{ noteId, createdAt: note.createdAt, updatedAt: note.updatedAt }}
          onOpenNote={() => {}}
        />
      </div>
    </>
  )
}
