import { t } from './i18n'
import { openBuy, soldOnAppStore, useLicence } from './licence'

/** Buy, wherever sync or AI is locked: the licence site in the browser, or the App Store's sheet. */
export function LicenceButton() {
  const store = soldOnAppStore(useLicence())
  return (
    <button type="button" className="button" onClick={openBuy}>
      {t(store ? 'licenceSettings.buyPro' : 'licenceSettings.buy')}
    </button>
  )
}
