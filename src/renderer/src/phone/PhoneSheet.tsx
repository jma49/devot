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
        </div>
        <div className="phone-sheet-body">{props.children}</div>
      </div>
    </div>
  )
}

/** One choice in a sheet's list: a row that closes the sheet once picked. */
export function SheetChoice(props: {
  label: string
  selected?: boolean
  destructive?: boolean
  value?: string
  onPick?: () => void
  lead?: ReactNode
}) {
  return (
    <li className="phone-grouped-row">
      <button
        type="button"
        className="phone-grouped-open phone-sheet-row"
        data-destructive={props.destructive || undefined}
        aria-pressed={props.selected}
        disabled={!props.onPick}
        onClick={props.onPick}
      >
        {props.lead}
        <span className="phone-grouped-label">{props.label}</span>
        {props.value !== undefined && <span className="phone-grouped-count">{props.value}</span>}
        {props.selected && (
          <span className="phone-sheet-check">
            <Icon name="check" size="sm" />
          </span>
        )}
      </button>
    </li>
  )
}
