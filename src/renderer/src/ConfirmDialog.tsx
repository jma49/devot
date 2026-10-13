import { useEffect, useRef, useState } from 'react'
import { t } from './i18n'

/**
 * A modal confirmation for a destructive action. Escape or Cancel declines.
 * Cancel takes the keyboard, so Return declines too; with `confirmFirst`
 * the confirming button does, and Return confirms. When it goes away, focus returns to whatever had it before it opened, if
 * that is still on the page and nothing else took focus meanwhile.
 */
export function ConfirmDialog(props: {
  message: string
  detail: string
  confirm: string
  confirmFirst?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const { confirmFirst } = props
  // Read during the first render, before showModal moves focus into the dialog.
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    // showModal focuses the first button, Cancel.
    if (confirmFirst) confirmButton.current?.focus()
    return () => {
      // Deferred: a dialog still on the page was only remounted (StrictMode).
      queueMicrotask(() => {
        if (!el || el.isConnected || !opener?.isConnected) return
        const active = document.activeElement
        if (active && active !== document.body) return
        opener.focus()
      })
    }
  }, [opener, confirmFirst])
  return (
    <dialog
      ref={dialog}
      className="confirm"
      aria-labelledby="confirm-message"
      aria-describedby="confirm-detail"
      onCancel={(e) => {
        e.preventDefault()
        props.onCancel()
      }}
    >
      <p id="confirm-message" className="confirm-message">
        {props.message}
      </p>
      <p id="confirm-detail" className="confirm-detail">
        {props.detail}
      </p>
      <div className="confirm-actions">
        <button type="button" className="button" onClick={props.onCancel} autoFocus>
          {t('dialog.cancel')}
        </button>
        <button
          type="button"
          className="button button-destructive"
          onClick={props.onConfirm}
          ref={confirmButton}
        >
          {props.confirm}
        </button>
      </div>
    </dialog>
  )
}
