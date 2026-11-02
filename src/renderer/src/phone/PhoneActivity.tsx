import { t } from '../i18n'

export function PhoneActivity() {
  const title = t('phone.tab.activity')
  return (
    <section aria-label={title} className="phone-screen">
      <div className="phone-scroll">
        <p className="phone-list-empty">{t('phone.activity.empty')}</p>
      </div>
      <div aria-hidden="true" className="phone-topbar-band" />
      <header className="phone-topbar">
        <h1 className="phone-topbar-title">{title}</h1>
      </header>
    </section>
  )
}
