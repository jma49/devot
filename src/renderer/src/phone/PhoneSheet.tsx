import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { t } from '../i18n'
import { Icon } from '../icons/Icon'
import { isImeKey } from '../ime'
import { motionMs } from '../motionTiming'
import { watchDragEnd, type DragEnd } from './dragEnd'
import { holdModal, isTopModal } from './modal'

const DISMISS_TRAVEL = 120
const DISMISS_SPEED = 0.5

/** Whether letting go of a sheet dragged down by `travel` at `speed` (points a millisecond) closes it. */
export const sheetCloses = (travel: number, speed: number): boolean =>
  travel > DISMISS_TRAVEL || (speed > DISMISS_SPEED && travel > 24)

/**
 * A modal bottom sheet: grows in with `gentle`, and a drag down on its top or Escape closes it.
 * While open it holds the keyboard and the rest of the app is inert; closed, it gives the
 * keyboard back to what had it.
 */
export function PhoneSheet(props: {
  title: string
  onClose: () => void
  children: ReactNode
  tall?: boolean
  /** No head: the contents bring their own title. */
  plain?: boolean
  /** A full-width glass button under the contents that closes the sheet. */
  done?: string
}) {
  const [shown, setShown] = useState(false)
  const [drag, setDrag] = useState<number | null>(null)
  const start = useRef<{
    pointer: number
    y: number
    lastY: number
    at: number
    speed: number
    stop: () => void
  } | null>(null)
  const closing = useRef(false)
  const layer = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  useLayoutEffect(() => {
    const own = layer.current
    const sheet = dialog.current
    if (!own || !sheet) return
    const trigger = document.activeElement
    const release = holdModal(own)
    sheet.focus({ preventScroll: true })
    // A control that goes away with the focus (the tag sheet swapping in its colour picker)
    // drops it to the page: the sheet takes it back.
    const regain = new MutationObserver(() => {
      const active = document.activeElement
      if ((active === null || active === document.body) && isTopModal(own)) {
        sheet.focus({ preventScroll: true })
      }
    })
    regain.observe(sheet, { childList: true, subtree: true })
    return () => {
      regain.disconnect()
      release()
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true })
    }
  }, [])
  const close = () => {
    if (closing.current) return
    closing.current = true
    setShown(false)
    setDrag(null)
    setTimeout(props.onClose, motionMs('motion.duration.phone-push'))
  }
  const move = (event: PointerEvent) => {
    const s = start.current
    if (!s || s.pointer !== event.pointerId) return
    const elapsed = event.timeStamp - s.at
    if (elapsed > 0) s.speed = (event.clientY - s.lastY) / elapsed
    s.lastY = event.clientY
    s.at = event.timeStamp
    setDrag(Math.max(0, event.clientY - s.y))
  }
  const end = (how: DragEnd, event: globalThis.PointerEvent | null) => {
    const s = start.current
    start.current = null
    if (!s) return
    if (how === 'release' && event && sheetCloses(event.clientY - s.y, s.speed)) close()
    else setDrag(null)
  }
  useEffect(() => () => start.current?.stop(), [])
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isImeKey(event.nativeEvent)) return
    // A sheet opened from this one is a child in React, so its keys would reach this one too.
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === 'Tab' && dialog.current) {
      // WebKit leaves buttons out of Tab unless the system says otherwise, and past the last
      // control Tab would leave the page: the sheet moves the keyboard round its own controls.
      event.preventDefault()
      event.stopPropagation()
      const controls = tabbable(dialog.current)
      const at = controls.indexOf(document.activeElement as HTMLElement)
      const step = event.shiftKey ? -1 : 1
      const next = at === -1 ? (event.shiftKey ? controls.length - 1 : 0) : at + step
      controls.at(next % controls.length)?.focus()
    }
  }
  // A screen's layer is its own stacking context under the tab bar and the compose circle.
  const host = document.querySelector('.phone-app') ?? document.body
  return createPortal(
    <div ref={layer} className="phone-sheet-layer">
      <div
        className="phone-sheet-dim"
        data-shown={shown || undefined}
        onClick={close}
        aria-hidden="true"
      />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        onKeyDown={onKey}
        className="phone-sheet"
        data-shown={shown || undefined}
        data-tall={props.tall || undefined}
        data-dragging={drag !== null || undefined}
        style={drag !== null ? { transform: `translateY(${drag}px)` } : undefined}
      >
        <div
          className="phone-sheet-handle"
          onPointerDown={(event) => {
            // A capture would take the click from a button in the handle (Close).
            if ((event.target as Element).closest('button') || start.current) return
            event.currentTarget.setPointerCapture(event.pointerId)
            start.current = {
              pointer: event.pointerId,
              y: event.clientY,
              lastY: event.clientY,
              at: event.timeStamp,
              speed: 0,
              stop: watchDragEnd(event.currentTarget, event.pointerId, end),
            }
          }}
          onPointerMove={move}
        >
          <span aria-hidden="true" className="phone-sheet-grabber" />
          {props.plain ? null : (
            <div className="phone-sheet-head">
              <h2 className="phone-sheet-title">{props.title}</h2>
              <button
                type="button"
                className="phone-glass phone-sheet-close"
                aria-label={t('phone.close')}
                onClick={close}
              >
                <Icon name="phone.close" size="sm" />
              </button>
            </div>
          )}
        </div>
        <div className="phone-sheet-body">
          {props.children}
          {props.done && (
            <button type="button" className="phone-glass phone-detail-done" onClick={close}>
              {props.done}
            </button>
          )}
        </div>
      </div>
    </div>,
    host,
  )
}

const TABBABLE = 'button, input, select, textarea, a[href], [tabindex]'

function tabbable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) =>
      el.tabIndex >= 0 &&
      !(el as HTMLButtonElement).disabled &&
      !el.closest('[inert]') &&
      el.getClientRects().length > 0,
  )
}

/** A short message in a sheet: title, body and a full-width Done. */
export function PhoneDetailSheet(props: { title: string; body: string; onClose: () => void }) {
  return (
    <PhoneSheet title={props.title} onClose={props.onClose} plain done={t('phone.hint.done')}>
      <div className="phone-detail-head">
        <span className="phone-detail-icon">
          <Icon name="phone.info" size="md" />
        </span>
        <h2 className="phone-detail-title">{props.title}</h2>
      </div>
      <p className="phone-detail-body">{props.body}</p>
    </PhoneSheet>
  )
}

/** One row of a sheet's list: a choice when it has `onPick`, otherwise plain information. */
export function SheetChoice(props: {
  label: string
  selected?: boolean
  destructive?: boolean
  value?: string
  figures?: boolean
  onPick?: () => void
  lead?: ReactNode
}) {
  const contents = (
    <>
      {props.lead}
      <span className="phone-grouped-text">
        <span className="phone-grouped-label">{props.label}</span>
        {props.value !== undefined && (
          <span className={`phone-grouped-count${props.figures ? ' phone-figures' : ''}`}>
            {props.value}
          </span>
        )}
      </span>
      {props.selected && (
        <span className="phone-sheet-check">
          <Icon name="check" size="sm" />
        </span>
      )}
    </>
  )
  return (
    <li className="phone-grouped-row">
      {props.onPick ? (
        <button
          type="button"
          className="phone-grouped-open phone-sheet-row"
          data-destructive={props.destructive || undefined}
          aria-pressed={props.selected}
          onClick={props.onPick}
        >
          {contents}
        </button>
      ) : (
        <div className="phone-grouped-open phone-sheet-row">{contents}</div>
      )}
    </li>
  )
}
