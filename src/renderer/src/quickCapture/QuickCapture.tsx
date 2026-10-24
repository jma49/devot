import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { errorCode } from '../../../core/errors'
import { clipTitle } from '../../../core/noteLimits'
import { useEditorSetting } from '../editorSettings'
import { format, t, type MessageKey } from '../i18n'
import { isImeKey } from '../ime'
import { invoke } from '../ipc'
import { readNotebooks, subscribeNotebooks, type NotebookChoice } from '../notebookChoices'
import { clearDraft, isEmptyCapture, notebookToShow, readDraft, writeDraft } from './draft'

// One string, so the store's snapshot is stable between changes.
const notebooksJson = () => JSON.stringify(readNotebooks())

const indented = (name: string, depth: number) => `${'  '.repeat(depth)}${name}`

function failure(code: string): MessageKey {
  if (code === 'E_BOOK_NOT_FOUND') return 'quickCapture.notebookGone'
  if (code === 'E_QUICK_CAPTURE_TIMEOUT' || code === 'E_QUICK_CAPTURE_NO_WINDOW')
    return 'quickCapture.noAnswer'
  return 'quickCapture.saveFailed'
}

const close = () =>
  invoke('quick_capture_close').catch((e: unknown) =>
    console.warn('W_QUICK_CAPTURE_CLOSE_FAILED', errorCode(e)),
  )

const plain = (e: KeyboardEvent) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey

/**
 * The quick capture window (menu bar mode): a title, a body and a notebook.
 * The main window's core saves the note (src-tauri/src/menu_bar.rs); until
 * it has, the text stays here and in the draft.
 */
export function QuickCapture() {
  const ids = useId()
  const notebooks = JSON.parse(
    useSyncExternalStore(subscribeNotebooks, notebooksJson),
  ) as NotebookChoice[]
  const defaultNotebook = useEditorSetting('defaultNotebook')
  const [draft] = useState(readDraft)
  const [title, setTitle] = useState(draft?.title ?? '')
  const [body, setBody] = useState(draft?.body ?? '')
  // Undefined until a notebook is picked: the default notebook shows then.
  const [picked, setPicked] = useState<string | null | undefined>(draft ? draft.bookId : undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const bodyField = useRef<HTMLTextAreaElement>(null)
  const bookId = notebookToShow(
    picked,
    defaultNotebook,
    notebooks.map((n) => n.id),
  )
  const empty = isEmptyCapture({ title, body })

  useEffect(() => writeDraft({ title, body, bookId }), [title, body, bookId])

  const save = async () => {
    if (empty || saving) return
    setSaving(true)
    setError(undefined)
    try {
      await invoke('quick_capture_save', { capture: { title: clipTitle(title), body, bookId } })
    } catch (e) {
      setError(errorCode(e, 'E_QUICK_CAPTURE_FAILED'))
      setSaving(false)
      return
    }
    // Emptied before the window goes, so a window that stays never sends the note twice.
    clearDraft()
    setTitle('')
    setBody('')
    setPicked(undefined)
    setSaving(false)
    void close()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (isImeKey(e.nativeEvent)) return
    if (e.key === 'Enter' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape' && plain(e)) {
      e.preventDefault()
      // A note on its way may still be made after the window has gone, and its draft would stay.
      if (!saving) void close()
    }
  }

  const onTitleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || !plain(e) || isImeKey(e.nativeEvent)) return
    e.preventDefault()
    bodyField.current?.focus()
  }

  return (
    <main className="quick-capture" aria-label={t('quickCapture.label')} onKeyDown={onKeyDown}>
      <input
        className="quick-capture-title"
        aria-label={t('quickCapture.title')}
        placeholder={t('quickCapture.title')}
        value={title}
        readOnly={saving}
        autoFocus
        onChange={(e) => setTitle(e.currentTarget.value)}
        onKeyDown={onTitleKeyDown}
      />
      <textarea
        ref={bodyField}
        className="quick-capture-body"
        aria-label={t('quickCapture.body')}
        placeholder={t('quickCapture.body')}
        value={body}
        readOnly={saving}
        onChange={(e) => setBody(e.currentTarget.value)}
      />
      {error ? (
        <p role="alert" className="quick-capture-error">
          {format(t(failure(error)), { code: error })}
        </p>
      ) : null}
      <div className="quick-capture-bar">
        <label className="visually-hidden" htmlFor={`${ids}-notebook`}>
          {t('quickCapture.notebook')}
        </label>
        <select
          id={`${ids}-notebook`}
          className="quick-capture-notebook"
          value={bookId ?? ''}
          disabled={saving}
          onChange={(e) => setPicked(e.currentTarget.value || null)}
        >
          <option value="">{t('quickCapture.noNotebook')}</option>
          {notebooks.map((n) => (
            <option key={n.id} value={n.id}>
              {indented(n.name, n.depth)}
            </option>
          ))}
        </select>
        <button type="button" className="button" disabled={saving} onClick={() => void close()}>
          {t('quickCapture.cancel')}
        </button>
        <button
          type="button"
          className="button button-default"
          disabled={empty || saving}
          onClick={() => void save()}
        >
          {t('quickCapture.save')}
        </button>
      </div>
    </main>
  )
}
