import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { Icon } from '../icons/Icon'
import { STATUS_LABEL, statusTile } from './pickers'
import type { PhoneStore } from './usePhoneData'

/** The accent new-note circle, which grows in place into the capture sheet. */
export function PhoneCapture(props: {
  store: PhoneStore
  available: boolean
  bookId: string | null
  onSaved: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) field.current?.focus({ preventScroll: true })
  }, [open])
  const book = props.store.books.find((b) => b.id === props.bookId)
  const shown = open || props.available

  const save = async () => {
    const core = props.store.core
    if (!core || saving) return
    setSaving(true)
    try {
      const id = await core.capture(title.trim(), body, props.bookId)
      await core.setStatus(id, 'active')
      setOpen(false)
      setTitle('')
      setBody('')
      props.onSaved(id)
    } catch {
      console.warn('W_PHONE_CAPTURE_FAILED')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div
        className="phone-capture-dim"
        data-shown={open || undefined}
        aria-hidden="true"
        onClick={() => setOpen(false)}
      />
      <div
        className="phone-capture"
        data-open={open || undefined}
        data-hidden={!shown || undefined}
        role={open ? 'dialog' : undefined}
        aria-modal={open || undefined}
        aria-label={open ? t('noteList.newNote') : undefined}
      >
        <button
          type="button"
          className="phone-capture-fab"
          aria-label={t('noteList.newNote')}
          tabIndex={open || !shown ? -1 : 0}
          onClick={() => setOpen(true)}
        >
          <Icon name="note.new" size="lg" />
        </button>
        <form
          className="phone-capture-body"
          inert={!open}
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className="phone-capture-head">
            <button
              type="button"
              className="phone-glass phone-capture-cancel"
              onClick={() => setOpen(false)}
            >
              {t('dialog.cancel')}
            </button>
            <span className="phone-capture-title">{t('noteList.newNote')}</span>
            <button
              type="submit"
              className="phone-capture-save"
              aria-label={t('phone.capture.save')}
              disabled={saving || (!title.trim() && !body.trim())}
            >
              <Icon name="phone.save" size="md" />
            </button>
          </div>
          <label className="phone-capture-field">
            <span>{t('phone.capture.title')}</span>
            <input ref={field} value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="phone-capture-field">
            <span>{t('phone.capture.note')}</span>
            <textarea rows={4} value={body} onChange={(event) => setBody(event.target.value)} />
          </label>
          <div className="phone-chips">
            <span className="phone-chip phone-chip-strong">
              {book?.name ?? t('phone.noNotebook')}
            </span>
            <span
              className="phone-chip phone-chip-strong"
              style={{ background: statusTile('active') }}
            >
              {t(STATUS_LABEL.active)}
            </span>
          </div>
        </form>
      </div>
    </>
  )
}
