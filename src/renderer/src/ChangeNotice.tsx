import { changeMessage } from './changeMessage'
import { t } from './i18n'

export function ChangeNotice(props: { code: string; onDismiss: () => void }) {
  return (
    <div role="alert" className="notice" data-devot-part="notice">
      <span className="notice-text">{changeMessage(props.code)}</span>
      <button type="button" className="button" onClick={props.onDismiss}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
