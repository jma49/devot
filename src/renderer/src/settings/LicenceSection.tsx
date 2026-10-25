import { useEffect, useId, useState } from 'react'
import { errorCode } from '../backups'
import { ConfirmDialog } from '../ConfirmDialog'
import { currentLocale, format, t } from '../i18n'
import { addLicence, removeLicence, startLicence, useLicence } from '../licence'
import { LicenceButton } from '../LicenceLocked'
import { licenceDate, licenceProblem, stateSentence } from '../licenceView'
import { Setting, SettingsNote, SettingsSection } from './controls'

/**
 * Settings > Licence: the licence on this device (who it is for, its ID, the last release it
 * covers and what that means here), a field to add or replace a key, Remove, and Buy or Renew in
 * the browser. The key goes to Rust, which checks it, and never comes back.
 */
export function LicenceSection() {
  const ids = useId()
  const id = (name: string) => `${ids}-${name}`
  const licence = useLicence()
  const [key, setKey] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string>()
  const [announcement, setAnnouncement] = useState('')
  const [confirming, setConfirming] = useState(false)
  const locale = currentLocale()

  useEffect(() => startLicence(), [])

  const held = licence.state !== 'none'
  const add = () => {
    if (key.trim() === '' || adding) return
    setAdding(true)
    void addLicence(key)
      .then(
        () => {
          setError(undefined)
          setKey('')
          setAnnouncement(t('licenceSettings.added'))
        },
        (e: unknown) => {
          setAnnouncement('')
          setError(
            format(t('licenceSettings.addFailed'), { problem: licenceProblem(errorCode(e)) }),
          )
        },
      )
      .finally(() => setAdding(false))
  }

  const remove = () => {
    setConfirming(false)
    void removeLicence().then(
      () => {
        setError(undefined)
        setAnnouncement(t('licenceSettings.removed'))
      },
      (e: unknown) => {
        setAnnouncement('')
        setError(format(t('licenceSettings.removeFailed'), { code: errorCode(e) }))
      },
    )
  }

  return (
    <section className="settings-section" aria-labelledby="licence-title">
      <h2 id="licence-title" className="visually-hidden">
        {t('licenceSettings.title')}
      </h2>
      {error ? (
        <p role="alert" className="settings-error">
          {error}
        </p>
      ) : null}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      <SettingsSection icon="settings.licence" title="licenceSettings.title">
        <SettingsNote>{t('licenceSettings.detail')}</SettingsNote>
        {licence.gated || licence.state === 'none' ? null : (
          <SettingsNote>{t('licenceSettings.ungated')}</SettingsNote>
        )}
        <Setting label="licenceSettings.status" description={stateSentence(licence, locale)}>
          {licence.state === 'valid' ? null : (
            <div className="settings-buttons">
              <LicenceButton licence={licence} />
            </div>
          )}
        </Setting>
        {licence.licensee ? (
          <Setting label="licenceSettings.licensee" description={licence.licensee}>
            {null}
          </Setting>
        ) : null}
        {licence.id ? (
          <Setting label="licenceSettings.id" description={licence.id}>
            {null}
          </Setting>
        ) : null}
        {licence.updatesUntil ? (
          <Setting
            label="licenceSettings.updatesUntil"
            description={`${licenceDate(licence.updatesUntil, locale)}. ${t('licenceSettings.updatesUntilHint')}`}
          >
            {null}
          </Setting>
        ) : null}
        <Setting
          label="licenceSettings.key"
          description={t(held ? 'licenceSettings.replaceHint' : 'licenceSettings.keyHint')}
          htmlFor={id('key')}
          descriptionId={id('key-hint')}
        >
          <input
            id={id('key')}
            type="text"
            className="settings-number settings-text"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            value={key}
            aria-describedby={id('key-hint')}
            onChange={(e) => setKey(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
            }}
          />
          <div className="settings-buttons">
            <button
              type="button"
              className="button"
              disabled={key.trim() === '' || adding}
              onClick={add}
            >
              {t(held ? 'licenceSettings.replace' : 'licenceSettings.add')}
            </button>
            <button
              type="button"
              className="button"
              disabled={!held}
              onClick={() => setConfirming(true)}
            >
              {t('licenceSettings.removeAsk')}
            </button>
          </div>
        </Setting>
      </SettingsSection>
      {confirming ? (
        <ConfirmDialog
          message={t('licenceSettings.removeConfirm')}
          detail={t('licenceSettings.removeDetail')}
          confirm={t('licenceSettings.remove')}
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </section>
  )
}
