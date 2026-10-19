import { countOf } from './format'
import { currentLocale, t } from './i18n'

export function BatchNotice(props: { failed: number; onDismiss: () => void }) {
  return (
    <div role="alert" className="notice" data-devot-part="notice">
      <span className="notice-text">
        {countOf(props.failed, currentLocale(), 'batch.failedOne', 'batch.failedOther')}
      </span>
      <button type="button" className="button" onClick={props.onDismiss}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
