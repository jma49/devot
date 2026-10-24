import { aiSuggestFailure } from './aiEditView'
import { t } from './i18n'

export function AiSuggestNotice(props: { code: string; onDismiss: () => void }) {
  return (
    <div role="alert" className="notice" data-devot-part="notice">
      <span className="notice-text">{aiSuggestFailure(props.code)}</span>
      <button type="button" className="button" onClick={props.onDismiss}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
