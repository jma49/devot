import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { format, t } from './i18n'

/** An image to show: its address and its alt text. */
export interface ViewedImage {
  src: string
  alt: string
}

/**
 * The image viewer: a modal over the whole window showing one image, fitted
 * to the window or at its actual size (scrolling when larger). The modal
 * keeps the keyboard inside it; Escape or Close dismisses it, and focus
 * returns to whatever had it before. Clicking the image also switches
 * between the two sizes.
 */
export function ImageViewer({ image, onClose }: { image: ViewedImage; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const [actual, setActual] = useState(false)
  // Read during the first render, before showModal moves focus into the
  // dialog; inside the editor's shadow root, the element that has it there.
  const [opener] = useState(() => {
    let active = document.activeElement
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
    return active instanceof HTMLElement ? active : null
  })
  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    close.current?.focus()
    return () => {
      // Deferred: a dialog still on the page was only remounted (StrictMode).
      queueMicrotask(() => {
        if (!el || el.isConnected || !opener?.isConnected) return
        const active = document.activeElement
        if (active && active !== document.body) return
        opener.focus()
      })
    }
  }, [opener])

  // Tab and Shift+Tab go round the viewer's controls: the web view would
  // otherwise move the keyboard out of the page after the last one.
  const keepTab = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || !dialog.current) return
    const stops = Array.from(
      dialog.current.querySelectorAll<HTMLElement>('button, [tabindex="0"]'),
    ).filter((el) => !el.hasAttribute('disabled'))
    const first = stops[0]
    const last = stops[stops.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !dialog.current.contains(active))) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && (active === last || !dialog.current.contains(active))) {
      event.preventDefault()
      first?.focus()
    }
  }

  return (
    <dialog
      ref={dialog}
      className="image-viewer"
      aria-label={
        image.alt ? format(t('imageViewer.labelNamed'), { alt: image.alt }) : t('imageViewer.label')
      }
      data-zoom={actual ? 'actual' : 'fit'}
      onKeyDown={keepTab}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div className="image-viewer-bar">
        <div className="segmented" role="group" aria-label={t('imageViewer.zoom')}>
          <button
            type="button"
            className="segment image-viewer-zoom"
            aria-pressed={!actual}
            onClick={() => setActual(false)}
          >
            {t('imageViewer.fit')}
          </button>
          <button
            type="button"
            className="segment image-viewer-zoom"
            aria-pressed={actual}
            onClick={() => setActual(true)}
          >
            {t('imageViewer.actual')}
          </button>
        </div>
        <button type="button" className="button" onClick={onClose} ref={close}>
          {t('imageViewer.close')}
        </button>
      </div>
      {/* Focusable, so the arrow keys scroll an image larger than the window. */}
      <div className="image-viewer-stage" tabIndex={0}>
        <img
          className="image-viewer-image"
          src={image.src}
          alt={image.alt}
          draggable={false}
          onClick={() => setActual((a) => !a)}
        />
      </div>
    </dialog>
  )
}
