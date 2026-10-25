import { t } from './i18n'
import { openBuy } from './licence'

/** Buy, in the browser, wherever sync or AI is locked. */
export function LicenceButton() {
  return (
    <button type="button" className="button" onClick={openBuy}>
      {t('licenceSettings.buy')}
    </button>
  )
}
