import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { format, t } from './i18n'
import { resizeFrom } from './resizeMotion'
import { useSegmentSlide } from './segmentSlide'

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
  const zoomGroup = useRef<HTMLDivElement>(null)
  useSegmentSlide(zoomGroup, actual ? 1 : 0)
  const shown = useRef<HTMLImageElement>(null)
  const zoomedFrom = useRef<DOMRect | null>(null)
  const zoom = (next: (was: boolean) => boolean) => {
    zoomedFrom.current = shown.current?.getBoundingClientRect() ?? null
    setActual(next)
  }
  useLayoutEffect(() => {
    const from = zoomedFrom.current
    zoomedFrom.current = null
    if (from && shown.current) resizeFrom(shown.current, from)
  }, [actual])
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

  // Tab and Shift+Tab go round the viewer's controls, every stop of them:
  // with macOS's default keyboard setting the web view would skip buttons,
  // and after the last stop (or before the first) it would leave the page.
  const keepTab = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || !dialog.current) return
    const stops = Array.from(
      dialog.current.querySelectorAll<HTMLElement>('button, [tabindex="0"]'),
    ).filter((el) => !el.hasAttribute('disabled'))
    if (stops.length === 0) return
    event.preventDefault()
    const at = stops.findIndex((el) => el === document.activeElement)
    const step = event.shiftKey ? -1 : 1
    const to =
      at < 0 ? (step > 0 ? 0 : stops.length - 1) : (at + step + stops.length) % stops.length
    stops[to]?.focus()
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
        <div ref={zoomGroup} className="segmented" role="group" aria-label={t('imageViewer.zoom')}>
          <button
            type="button"
            className="segment image-viewer-zoom"
            aria-pressed={!actual}
            onClick={() => zoom(() => false)}
          >
            {t('imageViewer.fit')}
          </button>
          <button
            type="button"
            className="segment image-viewer-zoom"
            aria-pressed={actual}
            onClick={() => zoom(() => true)}
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
          ref={shown}
          className="image-viewer-image"
          src={image.src}
          alt={image.alt}
          draggable={false}
          onClick={() => zoom((a) => !a)}
        />
      </div>
    </dialog>
  )
}
