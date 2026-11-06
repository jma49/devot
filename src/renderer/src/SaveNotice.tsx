import type { SaveProblem } from '../../core'
import { countOf } from './format'
import { currentLocale, t } from './i18n'

/**
 * Tells the user that changes to some notes could not be saved: Devot keeps
 * them and keeps trying (see saving.ts), and logged each failure's code.
 * After a quit (or a note window's close) held for them, it says how to go
 * on without them.
 */
export function SaveNotice(props: {
  problems: readonly SaveProblem[]
  quitHeld: boolean
  closeHeld?: boolean
  onRetry: () => void
  onDismiss: () => void
}) {
  const [one, other] = props.quitHeld
    ? (['save.quitHeldOne', 'save.quitHeldOther'] as const)
    : props.closeHeld
      ? (['save.closeHeldOne', 'save.closeHeldOther'] as const)
      : (['save.failedOne', 'save.failedOther'] as const)
  const text = countOf(props.problems.length, currentLocale(), one, other)
  return (
    <div role="alert" className="notice" data-devot-part="notice">
      <span className="notice-text">{text}</span>
      <button type="button" className="button" onClick={props.onRetry}>
        {t('save.retry')}
      </button>
      <button type="button" className="button" onClick={props.onDismiss}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
