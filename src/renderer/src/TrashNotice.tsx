import { useEffect, useState } from 'react'
import { countOf } from './format'
import { currentLocale, t } from './i18n'
import { sizes } from './theme/tokens'

const STAYS_MS = Number.parseFloat(sizes['motion.duration.notice-undo'])

/** Notes just moved to the Trash, with Undo; it goes by itself unless the pointer or the keyboard is on it. */
export function TrashNotice(props: { count: number; onUndo: () => void; onDismiss: () => void }) {
  const { onDismiss } = props
  const [held, setHeld] = useState({ pointer: false, focus: false })
  const resting = !held.pointer && !held.focus
  useEffect(() => {
    if (!resting) return
    const timer = window.setTimeout(onDismiss, STAYS_MS)
    return () => window.clearTimeout(timer)
  }, [resting, onDismiss])
  return (
    <div
      role="status"
      className="notice"
      data-devot-part="notice"
      onPointerEnter={() => setHeld((h) => ({ ...h, pointer: true }))}
      onPointerLeave={() => setHeld((h) => ({ ...h, pointer: false }))}
      onFocus={() => setHeld((h) => ({ ...h, focus: true }))}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setHeld((h) => ({ ...h, focus: false }))
      }}
    >
      <span className="notice-text">
        {countOf(props.count, currentLocale(), 'batch.trashedOne', 'batch.trashedOther')}
      </span>
      <button type="button" className="button" onClick={props.onUndo}>
        {t('notice.undo')}
      </button>
      <button type="button" className="button" onClick={onDismiss}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
