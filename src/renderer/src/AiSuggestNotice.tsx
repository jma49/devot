import { aiSuggestFailure } from './aiEditView'
import { t } from './i18n'
import { LICENCE_REQUIRED } from './licence'
import { LicenceButton } from './LicenceLocked'

export function AiSuggestNotice(props: { code: string; onDismiss: () => void }) {
  return (
    <div role="alert" className="notice" data-devot-part="notice">
      <span className="notice-text">{aiSuggestFailure(props.code)}</span>
      {props.code === LICENCE_REQUIRED ? <LicenceButton /> : null}
      <button type="button" className="button" onClick={props.onDismiss}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
