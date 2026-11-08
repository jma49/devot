import { useEffect, useId, useState } from 'react'
import { errorCode } from '../backups'
import { ConfirmDialog } from '../ConfirmDialog'
import { currentLocale, format, t } from '../i18n'
import {
  addLicence,
  openDevices,
  refreshLicence,
  removeLicence,
  startLicence,
  useLicence,
} from '../licence'
import { LicenceButton } from '../LicenceLocked'
import {
  licenceProblem,
  licenseeName,
  seatSentence,
  stateSentence,
  trialSentence,
} from '../licenceView'
import { Setting, SettingsNote, SettingsSection } from './controls'
import { failureText, logFailure } from '../failure'

const MINUTE_MS = 60_000

/** The time now, again every minute, for the trial's time left. */
function useMinutes(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

/**
 * Settings > Licence: the licence on this device (who it is for and its ID), the trial's time left
 * or that it ended, a field to add or replace a key, Remove, and Buy in the browser. The key goes
 * to Rust, which checks it, and never comes back.
 */
export function LicenceSection() {
  const ids = useId()
  const id = (name: string) => `${ids}-${name}`
  const licence = useLicence()
  const [key, setKey] = useState('')
  // One licence write at a time: a remove during a replace's seat activation would race it in Rust.
  const [running, setRunning] = useState<'add' | 'remove' | 'refresh'>()
  const [error, setError] = useState<string>()
  const [announcement, setAnnouncement] = useState('')
  const [confirming, setConfirming] = useState(false)
  const now = useMinutes()
  const trial = trialSentence(licence, now, currentLocale())

  useEffect(() => startLicence(), [])

  const held = licence.state !== 'none'
  const takesKeys = licence.appStore?.takesKeys ?? true
  const unlocked = licence.state === 'valid' || licence.appStore?.pro === true
  const add = () => {
    if (key.trim() === '' || running) return
    setRunning('add')
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
            format(t('licenceSettings.addFailed'), {
              problem: licenceProblem(logFailure(errorCode(e), 'W_LICENCE_SETTINGS_FAILED')),
            }),
          )
        },
      )
      .finally(() => setRunning(undefined))
  }

  const remove = () => {
    setConfirming(false)
    if (running) return
    setRunning('remove')
    void removeLicence()
      .then(
        () => {
          setError(undefined)
          setAnnouncement(t('licenceSettings.removed'))
        },
        (e: unknown) => {
          setAnnouncement('')
          setError(
            failureText(
              'licenceSettings.removeFailed',
              logFailure(errorCode(e), 'W_LICENCE_SETTINGS_FAILED'),
            ),
          )
        },
      )
      .finally(() => setRunning(undefined))
  }
  const retry = () => {
    if (running) return
    setRunning('refresh')
    void refreshLicence()
      .then(
        () => {
          setError(undefined)
          setAnnouncement(t('licenceSettings.devices.refreshed'))
        },
        (e: unknown) => {
          setAnnouncement('')
          setError(
            format(t('licenceSettings.devices.refreshFailed'), {
              problem: licenceProblem(logFailure(errorCode(e), 'W_LICENCE_SETTINGS_FAILED')),
            }),
          )
        },
      )
      .finally(() => setRunning(undefined))
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
      <SettingsSection title="licenceSettings.title">
        <SettingsNote>{t('licenceSettings.detail')}</SettingsNote>
        {licence.gated || licence.state === 'none' ? null : (
          <SettingsNote>{t('licenceSettings.ungated')}</SettingsNote>
        )}
        <Setting label="licenceSettings.status" description={stateSentence(licence)}>
          {unlocked ? null : (
            <div className="settings-buttons">
              <LicenceButton />
            </div>
          )}
        </Setting>
        {trial === null ? null : (
          <Setting label="licenceSettings.trial" description={trial}>
            {null}
          </Setting>
        )}
        {licence.activation ? (
          <Setting label="licenceSettings.devices" description={seatSentence(licence) ?? ''}>
            <div className="settings-buttons">
              {licence.activation.state === 'active' &&
              !['E_LICENCE_DEVICE_LIMIT', 'E_LICENCE_ACTIVATION_REQUIRED'].includes(
                licence.code ?? '',
              ) ? null : (
                <button
                  type="button"
                  className="button"
                  aria-disabled={running !== undefined}
                  onClick={retry}
                >
                  {t('licenceSettings.devices.retry')}
                </button>
              )}
              <button type="button" className="button" onClick={() => openDevices()}>
                {t('licenceSettings.devices.manage')}
              </button>
            </div>
          </Setting>
        ) : null}
        {licence.licensee ? (
          <Setting label="licenceSettings.licensee" description={licenseeName(licence.licensee)}>
            {null}
          </Setting>
        ) : null}
        {licence.id ? (
          <Setting label="licenceSettings.id" description={licence.id}>
            {null}
          </Setting>
        ) : null}
        {takesKeys ? (
          <Setting
            label="licenceSettings.key"
            description={t(held ? 'licenceSettings.replaceHint' : 'licenceSettings.keyHint')}
            htmlFor={id('key')}
            descriptionId={id('key-hint')}
          >
            <input
              id={id('key')}
              data-licence-key
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
              {/* aria-disabled, not disabled: a disabled button would drop the keyboard when the key clears. */}
              <button
                type="button"
                className="button"
                aria-disabled={key.trim() === '' || running !== undefined}
                onClick={add}
              >
                {t(held ? 'licenceSettings.replace' : 'licenceSettings.add')}
              </button>
              <button
                type="button"
                className="button"
                data-destructive
                aria-disabled={!held || running !== undefined}
                onClick={() => {
                  if (held && !running) setConfirming(true)
                }}
              >
                {t('licenceSettings.removeAsk')}
              </button>
            </div>
          </Setting>
        ) : null}
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
