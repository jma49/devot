import { t } from './i18n'
import { openBuy, openRenew, type LicenceSnapshot } from './licence'
import { renewable } from './licenceView'

/** Renew for a licence that ended before this version, Buy otherwise; both open the browser. */
export function LicenceButton(props: { licence: LicenceSnapshot }) {
  const { licence } = props
  return renewable(licence) ? (
    <button type="button" className="button" onClick={() => openRenew(licence.id)}>
      {t('licenceSettings.renew')}
    </button>
  ) : (
    <button type="button" className="button" onClick={openBuy}>
      {t('licenceSettings.buy')}
    </button>
  )
}
