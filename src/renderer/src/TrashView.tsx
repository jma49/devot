import { useEffect, useState } from 'react'
import type { Core } from './core-client'
import { t } from './i18n'
import { Preview } from './preview/Preview'

/** A trashed note, read-only, with Restore and Delete Permanently. */
export function TrashView(props: {
  core: Core
  noteId: string
  onRestore: () => void
  onDelete: (title: string) => void
}) {
  const { core, noteId } = props
  const [note, setNote] = useState<{ title: string; bodyMd: string }>()
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
  return (
    <>
      <div className="trash-banner" role="status">
        <span>{t('trash.banner')}</span>
        <button type="button" className="button" onClick={props.onRestore}>
          {t('trash.restore')}
        </button>
        <button
          type="button"
          className="button button-destructive"
          onClick={() => props.onDelete(note.title)}
        >
          {t('trash.deleteForever')}
        </button>
      </div>
      <h1 className="title trash-title">{note.title || t('note.untitled')}</h1>
      <div className="panes panes-preview">
        <Preview core={core} markdown={note.bodyMd} onOpenNote={() => {}} />
      </div>
    </>
  )
}
