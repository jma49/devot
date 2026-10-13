// The link dialog of the selection toolbar: a small modal asking for a
// link's text (the selection) and its URL. Return inserts `[text](url)` in
// place of the selection as one undo step; Escape or Cancel leaves the note
// as it was. Focus goes back to the editor either way.
import type { EditorView } from '@codemirror/view'
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { t } from '../i18n'
import { Icon } from '../icons/Icon'
import { insertLink } from './formats'

function LinkDialog(props: {
  text: string
  onInsert: (text: string, url: string) => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const urlField = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(props.text)
  const [url, setUrl] = useState('')
  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    urlField.current?.focus()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="link-dialog"
      aria-labelledby="link-dialog-title"
      onCancel={(e) => {
        e.preventDefault()
        props.onCancel()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (url.trim() !== '') props.onInsert(text, url)
        }}
      >
        <h2 id="link-dialog-title" className="link-dialog-title">
          <Icon name="format.link" size="sm" />
          {t('linkDialog.title')}
        </h2>
        <div className="link-dialog-fields">
          <input
            className="link-dialog-field"
            aria-label={t('linkDialog.text')}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <input
            ref={urlField}
            className="link-dialog-field"
            aria-label={t('linkDialog.url')}
            placeholder={t('linkDialog.urlPlaceholder')}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <div className="link-dialog-actions">
          <button type="button" className="link-dialog-button" onClick={props.onCancel}>
            {t('dialog.cancel')}
          </button>
          <button
            type="submit"
            className="link-dialog-button link-dialog-insert"
            aria-disabled={url.trim() === ''}
          >
            {t('linkDialog.insert')}
          </button>
        </div>
      </form>
    </dialog>
  )
}

/**
 * Opens the link dialog for the editor's main selection, its text
 * prefilled; the link replaces whatever is selected when it is inserted.
 */
export function openLinkDialog(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const close = () => {
    // Outside React's own event handling, which is still running.
    queueMicrotask(() => {
      root.unmount()
      host.remove()
      view.focus()
    })
  }
  root.render(
    <LinkDialog
      text={view.state.sliceDoc(from, to)}
      onInsert={(text, url) => {
        view.dispatch(insertLink(view.state, text, url))
        close()
      }}
      onCancel={close}
    />,
  )
}
