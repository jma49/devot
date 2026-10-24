import { useEffect, useId, useState } from 'react'
import { errorCode } from '../backups'
import { countOf } from '../format'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import {
  changeSync,
  createSyncVault,
  startSyncStatus,
  useSyncSnapshot,
  type SyncSnapshot,
  type SyncStateName,
} from '../sync'
import { Setting, SettingToggle, SettingsNote, SettingsSection } from './controls'

const STATES: Readonly<Record<SyncStateName, MessageKey>> = {
  off: 'syncSettings.state.off',
  connecting: 'syncSettings.state.connecting',
  syncing: 'syncSettings.state.syncing',
  idle: 'syncSettings.state.idle',
  offline: 'syncSettings.state.offline',
  paused: 'syncSettings.state.paused',
  stopped: 'syncSettings.state.stopped',
}

const when = (at: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at)

function statusText(snapshot: SyncSnapshot, locale: string): string {
  const { state, lastSync, code } = snapshot.status
  const parts = [t(STATES[snapshot.enabled ? state : 'off'])]
  if (code && snapshot.enabled && state !== 'idle')
    parts.push(format(t('syncSettings.code'), { code }))
  parts.push(
    lastSync === null
      ? t('syncSettings.neverSynced')
      : format(t('syncSettings.lastSync'), { time: when(lastSync, locale) }),
  )
  return parts.join(' ')
}

/**
 * Settings > Sync: the relay's URL, the relay's secret (asked once, on the device that creates the
 * vault, and never kept), sync on or off and its status. Pairing another device, the recovery key
 * and the device list come with issue 336, attachments with 327 and the relay's quota with 215.
 */
export function SyncSection() {
  const ids = useId()
  const id = (name: string) => `${ids}-${name}`
  const snapshot = useSyncSnapshot()
  const [url, setUrl] = useState<string>()
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<{ message: MessageKey; code: string }>()
  const [creating, setCreating] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const locale = currentLocale()

  useEffect(() => startSyncStatus(), [])

  const shownUrl = url ?? snapshot.relayUrl
  const failed = (message: MessageKey) => (e: unknown) => setError({ message, code: errorCode(e) })

  const saveUrl = () => {
    if (url === undefined || url.trim() === snapshot.relayUrl) {
      setUrl(undefined)
      return
    }
    void changeSync({ relayUrl: url }).then(() => {
      setError(undefined)
      setUrl(undefined)
    }, failed('syncSettings.urlFailed'))
  }

  const create = () => {
    if (secret.trim() === '' || creating) return
    setCreating(true)
    const sent = secret
    void createSyncVault(sent)
      .then(() => {
        setError(undefined)
        setSecret('')
        setAnnouncement(t('syncSettings.vaultReady'))
      }, failed('syncSettings.vaultFailed'))
      .finally(() => setCreating(false))
  }

  const needsVault = snapshot.relayUrl !== '' && !snapshot.enrolled

  return (
    <section className="settings-section" aria-labelledby="sync-title">
      <h2 id="sync-title" className="visually-hidden">
        {t('syncSettings.title')}
      </h2>
      {error ? (
        <p role="alert" className="settings-error">
          {format(t(error.message), { code: error.code })}
        </p>
      ) : null}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      <SettingsSection icon="settings.sync" title="syncSettings.title">
        <SettingsNote>{t('syncSettings.detail')}</SettingsNote>
        <Setting
          label="syncSettings.relay"
          description={t('syncSettings.relayHint')}
          htmlFor={id('relay')}
          descriptionId={id('relay-hint')}
        >
          <input
            id={id('relay')}
            type="url"
            className="settings-number settings-text"
            spellCheck={false}
            autoComplete="off"
            placeholder={t('syncSettings.relayPlaceholder')}
            value={shownUrl}
            aria-describedby={id('relay-hint')}
            onChange={(e) => setUrl(e.currentTarget.value)}
            onBlur={saveUrl}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveUrl()
            }}
          />
        </Setting>
        {needsVault ? (
          <Setting
            label="syncSettings.secret"
            description={t(
              snapshot.vault ? 'syncSettings.secretAgainHint' : 'syncSettings.secretHint',
            )}
            htmlFor={id('secret')}
            descriptionId={id('secret-hint')}
          >
            <input
              id={id('secret')}
              type="password"
              className="settings-number settings-text"
              spellCheck={false}
              autoComplete="off"
              value={secret}
              aria-describedby={id('secret-hint')}
              onChange={(e) => setSecret(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') create()
              }}
            />
            <div className="settings-buttons">
              <button
                type="button"
                className="button"
                disabled={secret.trim() === '' || creating}
                onClick={create}
              >
                {t(snapshot.vault ? 'syncSettings.connect' : 'syncSettings.createVault')}
              </button>
            </div>
          </Setting>
        ) : null}
        <SettingToggle
          label="syncSettings.enabled"
          description="syncSettings.enabledHint"
          checked={snapshot.enabled}
          disabled={snapshot.relayUrl === ''}
          onChange={(on) =>
            void changeSync({ enabled: on }).then(
              () => setError(undefined),
              failed('syncSettings.changeFailed'),
            )
          }
        />
        <Setting label="syncSettings.status" description={statusText(snapshot, locale)}>
          {null}
        </Setting>
        {snapshot.status.tooLarge > 0 ? (
          <SettingsNote>
            {countOf(
              snapshot.status.tooLarge,
              locale,
              'syncSettings.tooLargeOne',
              'syncSettings.tooLargeOther',
            )}
          </SettingsNote>
        ) : null}
      </SettingsSection>
    </section>
  )
}
