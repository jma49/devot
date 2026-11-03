import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { t } from '../i18n'
import { Icon } from '../icons/Icon'
import { motionMs } from '../motionTiming'

const DISMISS_TRAVEL = 120
const DISMISS_SPEED = 0.5

/** Whether letting go of a sheet dragged down by `travel` at `speed` (points a millisecond) closes it. */
export const sheetCloses = (travel: number, speed: number): boolean =>
  travel > DISMISS_TRAVEL || (speed > DISMISS_SPEED && travel > 24)

/** A bottom sheet: grows in with `gentle`, and a drag down on its top closes it. */
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
  const start = useRef<{ y: number; lastY: number; at: number; speed: number } | null>(null)
  const closing = useRef(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(frame)
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
    if (!s) return
    const elapsed = event.timeStamp - s.at
    if (elapsed > 0) s.speed = (event.clientY - s.lastY) / elapsed
    s.lastY = event.clientY
    s.at = event.timeStamp
    setDrag(Math.max(0, event.clientY - s.y))
  }
  const end = (event: PointerEvent) => {
    const s = start.current
    start.current = null
    if (!s) return
    if (event.type === 'pointerup' && sheetCloses(event.clientY - s.y, s.speed)) close()
    else setDrag(null)
  }
  return (
    <div className="phone-sheet-layer">
      <div
        className="phone-sheet-dim"
        data-shown={shown || undefined}
        onClick={close}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
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
            if ((event.target as Element).closest('button')) return
            event.currentTarget.setPointerCapture(event.pointerId)
            start.current = {
              y: event.clientY,
              lastY: event.clientY,
              at: event.timeStamp,
              speed: 0,
            }
          }}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
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
    </div>
  )
}

/** A long explanation that does not sit under its row: title, body and a full-width Done. */
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
      <span className="phone-grouped-label">{props.label}</span>
      {props.value !== undefined && (
        <span className={`phone-grouped-count${props.figures ? ' phone-figures' : ''}`}>
          {props.value}
        </span>
      )}
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
