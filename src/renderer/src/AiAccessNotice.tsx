import type { AiAccessChange } from './aiAccess'
import { countOf } from './format'
import { currentLocale, t } from './i18n'

/** What the AI access picker just changed, with Undo; failures are counted, not listed. */
export function AiAccessNotice(props: {
  changes: readonly AiAccessChange[]
  failed: number
  onUndo: () => void
  onDismiss: () => void
}) {
  const locale = currentLocale()
  const on = props.changes.filter((change) => change.on).length
  const off = props.changes.length - on
  const text =
    props.failed > 0
      ? countOf(props.failed, locale, 'aiAccess.failedOne', 'aiAccess.failedOther')
      : on > 0 && off > 0
        ? countOf(props.changes.length, locale, 'aiAccess.mixedOne', 'aiAccess.mixedOther')
        : on > 0
          ? countOf(on, locale, 'aiAccess.onOne', 'aiAccess.onOther')
          : countOf(off, locale, 'aiAccess.offOne', 'aiAccess.offOther')
  return (
    <div role="status" className="notice" data-devot-part="notice">
      <span className="notice-text">{text}</span>
      {props.changes.length > 0 ? (
        <button type="button" className="button" onClick={props.onUndo}>
          {t('notice.undo')}
        </button>
      ) : null}
      <button type="button" className="button" onClick={props.onDismiss}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
