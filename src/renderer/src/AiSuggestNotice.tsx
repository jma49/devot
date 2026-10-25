import { aiSuggestFailure } from './aiEditView'
import { t } from './i18n'
import { LICENCE_REQUIRED, useLicence } from './licence'
import { LicenceButton } from './LicenceLocked'

export function AiSuggestNotice(props: { code: string; onDismiss: () => void }) {
  const licence = useLicence()
  return (
    <div role="alert" className="notice" data-devot-part="notice">
      <span className="notice-text">{aiSuggestFailure(props.code)}</span>
      {props.code === LICENCE_REQUIRED ? <LicenceButton licence={licence} /> : null}
      <button type="button" className="button" onClick={props.onDismiss}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
