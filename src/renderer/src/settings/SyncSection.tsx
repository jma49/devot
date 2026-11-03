import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { errorCode } from '../backups'
import { countOf, untilTime, uploadCounts } from '../format'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { licenceEntitlements, startLicence, useLicence, useTrialOver } from '../licence'
import { LicenceButton } from '../LicenceLocked'
import {
  changeSync,
  createSyncVault,
  pendingRecoveryKey,
  recoverySaved,
  startSyncStatus,
  STOP_ADVICE,
  STORAGE_FULL,
  usePauseOver,
  useSyncSnapshot,
  type SyncSnapshot,
  type SyncStateName,
} from '../sync'
import { PhoneGroup } from '../phone/PhoneControls'
import { Setting, SettingToggle, SettingsNote, SettingsSection } from './controls'
import { useOnPhone } from './onPhone'
import { DevicesRow, JoinRows, PairingRow, RecoveryKeyPanel } from './SyncDevices'
import { UsageRows } from './SyncUsage'

const SAY_AFTER_MS = 50

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

function pauseText(pausedUntil: number, pauseOver: boolean, locale: string, code: string | null) {
  const full = code === STORAGE_FULL
  if (pauseOver) return t(full ? 'syncSettings.storageFullRetry' : 'syncSettings.resuming')
  const time = untilTime(pausedUntil, Date.now(), locale)
  return format(t(full ? 'syncSettings.storageFull' : 'syncSettings.pausedUntil'), { time })
}

function statusText(snapshot: SyncSnapshot, pauseOver: boolean, locale: string): string {
  const { state, lastSync, code, pausedUntil, upload } = snapshot.status
  const shown = snapshot.enabled ? state : 'off'
  const parts = [
    shown === 'paused' && pausedUntil !== null
      ? pauseText(pausedUntil, pauseOver, locale, code)
      : t(STATES[shown]),
  ]
  if (shown === 'stopped' && code && STOP_ADVICE[code]) parts.push(t(STOP_ADVICE[code]))
  if (upload && snapshot.enabled)
    parts.push(format(t('syncSettings.upload'), uploadCounts(upload, locale)))
  if (code && snapshot.enabled && state !== 'idle')
    parts.push(format(t('syncSettings.code'), { code }))
  parts.push(
    lastSync === null
      ? t('syncSettings.neverSynced')
      : format(t('syncSettings.lastSync'), { time: when(lastSync, locale) }),
  )
  return parts.join(' ')
}

// Why a join, a pairing or a vault's creation failed, for the codes a person can act on.
const WHY: Readonly<Record<string, MessageKey>> = {
  E_SYNC_RELAY_OUTDATED: 'syncSettings.why.outdated',
  E_SYNC_VAULT_EXISTS: 'syncSettings.why.otherVault',
  E_SYNC_PAIRING_GONE: 'syncSettings.why.codeGone',
  E_SYNC_PAIRING_EXPIRED: 'syncSettings.why.codeGone',
  E_SYNC_PAIRING_CODE: 'syncSettings.why.codeMistyped',
  E_SYNC_PAIRING_CHECKSUM: 'syncSettings.why.codeMistyped',
  E_SYNC_PAIRING_VERSION: 'syncSettings.why.codeMistyped',
  E_SYNC_PAIRING_AUTH: 'syncSettings.why.codeRefused',
  E_SYNC_PAIRING_RELAY: 'syncSettings.why.otherRelay',
  E_SYNC_RECOVERY_FORMAT: 'syncSettings.why.keyMistyped',
  E_SYNC_RECOVERY_CHECKSUM: 'syncSettings.why.keyMistyped',
  E_SYNC_RECOVERY_VERSION: 'syncSettings.why.keyMistyped',
  E_SYNC_NO_RELAY: 'syncSettings.why.noRelay',
  E_SYNC_NO_VAULT: 'syncSettings.why.noVault',
  E_SYNC_RELAY_URL_INVALID: 'syncSettings.why.relayInvalid',
  E_SYNC_RELAY_SECRET: 'syncSettings.why.relaySecret',
  E_SYNC_RELAY_SECRET_INVALID: 'syncSettings.why.relaySecretInvalid',
  E_SYNC_OFFLINE: 'syncSettings.why.unreachable',
  E_SYNC_RELAY_FAILED: 'syncSettings.why.unreachable',
  E_SYNC_KEYCHAIN: 'syncSettings.why.keychain',
  E_SYNC_KEYCHAIN_UNAVAILABLE: 'syncSettings.why.keychain',
  E_SYNC_TOO_MANY_DEVICES: 'syncSettings.why.tooManyDevices',
  E_SYNC_ENROLL_DENIED: 'syncSettings.why.enrollDenied',
}

/**
 * Settings > Sync: the relay's URL, joining with a pairing code or the recovery key, or on the
 * first device only creating the vault with the relay's secret (asked once and never kept), the
 * recovery key until it is saved, showing a pairing code, the vault's devices, sync on or off and
 * its status.
 */
export function SyncSection() {
  const ids = useId()
  const id = (name: string) => `${ids}-${name}`
  const onPhone = useOnPhone()
  const snapshot = useSyncSnapshot()
  const pauseOver = usePauseOver(snapshot.status.pausedUntil)
  const [url, setUrl] = useState<string>()
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<{ message: MessageKey; code: string; n: number }>()
  const [creating, setCreating] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [recoveryKey, setRecoveryKey] = useState<string>()
  const [keyFocus, setKeyFocus] = useState(false)
  const [path, setPath] = useState<'first' | 'another'>()
  const [chosen, setChosen] = useState(0)
  const [backedOut, setBackedOut] = useState(0)
  const [focusPairing, setFocusPairing] = useState(0)
  const [devicesVersion, setDevicesVersion] = useState(0)
  const failures = useRef(0)
  const said = useRef<ReturnType<typeof setTimeout>>(undefined)
  const alert = useRef<HTMLParagraphElement>(null)
  const firstButton = useRef<HTMLButtonElement>(null)
  const root = useRef<HTMLElement>(null)
  const locale = currentLocale()

  useEffect(() => startSyncStatus(), [])
  useEffect(() => startLicence(), [])
  // Re-renders when the licence changes, which licenceEntitlements reads.
  useLicence()
  const trialEnded = useTrialOver()
  const locked = !licenceEntitlements.has('sync')

  const shownUrl = url ?? snapshot.relayUrl
  // A live region speaks only when its text changes, so it is emptied first to say the same
  // words again.
  const say = useCallback((text: string) => {
    clearTimeout(said.current)
    setAnnouncement('')
    if (text) said.current = setTimeout(() => setAnnouncement(text), SAY_AFTER_MS)
  }, [])
  useEffect(() => () => clearTimeout(said.current), [])
  const failed = useCallback(
    (message: MessageKey) => (e: unknown) => {
      say('')
      failures.current += 1
      setError({ message, code: errorCode(e), n: failures.current })
    },
    [say],
  )
  const announce = useCallback(
    (text: string) => {
      setError(undefined)
      say(text)
    },
    [say],
  )
  const devicesChanged = useCallback(() => setDevicesVersion((v) => v + 1), [])
  const joined = useCallback(() => {
    announce(t('syncSettings.joined'))
    setFocusPairing((n) => n + 1)
  }, [announce])

  // The rows that fail sit far below the alert, which a sighted person would not see otherwise.
  useEffect(() => {
    if (error) alert.current?.scrollIntoView({ block: 'nearest' })
  }, [error])

  // Rust keeps the key on offer until Saved, so a pane switch or a closed window does not lose it.
  useEffect(() => {
    if (!snapshot.enrolled) return
    let current = true
    pendingRecoveryKey().then(
      (key) => {
        if (current && key) setRecoveryKey(key)
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [snapshot.enrolled])

  // The choice replaces the question, so focus goes to the path's first field.
  useEffect(() => {
    if (chosen === 0) return
    const field =
      root.current?.querySelector<HTMLInputElement>('input[type=password]') ??
      root.current?.querySelector<HTMLInputElement>('input')
    field?.focus()
  }, [chosen])

  useEffect(() => {
    if (backedOut > 0) firstButton.current?.focus()
  }, [backedOut])

  const choose = (next: 'first' | 'another') => {
    setPath(next)
    setChosen((n) => n + 1)
  }

  const backOut = () => {
    setSecret('')
    setPath(undefined)
    setBackedOut((n) => n + 1)
  }

  const saved = () =>
    void recoverySaved().then(() => {
      setRecoveryKey(undefined)
      setFocusPairing((n) => n + 1)
    }, failed('syncSettings.recoverySaveFailed'))

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
    if (secret.trim() === '' || creating || locked) return
    setCreating(true)
    const sent = secret
    void createSyncVault(sent)
      .then((created) => {
        setError(undefined)
        setSecret('')
        setPath(undefined)
        if (created.recoveryKey) {
          setRecoveryKey(created.recoveryKey)
          setKeyFocus(true)
        }
        say(t('syncSettings.vaultReady'))
      }, failed('syncSettings.vaultFailed'))
      .finally(() => setCreating(false))
  }

  const needsVault = snapshot.relayUrl !== '' && !snapshot.enrolled
  // A device that holds a vault the relay does not know reconnects to it; it never starts another.
  const held = !snapshot.enrolled && snapshot.vault
  const asksSecret = needsVault && (held || path === 'first')
  const why = error ? WHY[error.code] : undefined
  const secretHint: MessageKey = !snapshot.vault
    ? 'syncSettings.secretHint'
    : snapshot.status.code === 'E_SYNC_REVOKED'
      ? 'syncSettings.secretRevokedHint'
      : 'syncSettings.secretAgainHint'

  const header = (
    <>
      <h2 id="sync-title" className="visually-hidden">
        {t('syncSettings.title')}
      </h2>
      {error ? (
        <p key={error.n} ref={alert} role="alert" className="settings-error">
          {format(t(error.message), { code: error.code })}
          {why ? ` ${t(why)}` : null}
        </p>
      ) : null}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </>
  )
  const lockedRow = (
    <>
      {locked ? (
        <Setting
          label="licenceSettings.title"
          description={t(trialEnded ? 'licence.locked.syncTrialEnded' : 'licence.locked.sync')}
        >
          <div className="settings-buttons">
            <LicenceButton />
          </div>
        </Setting>
      ) : null}
    </>
  )
  const recoveryPanel = (
    <>
      {recoveryKey ? (
        <RecoveryKeyPanel
          recoveryKey={recoveryKey}
          focus={keyFocus}
          onDone={saved}
          onAnnounce={announce}
          failed={failed}
        />
      ) : null}
    </>
  )
  const relayRow = (hint: string) => (
    <Setting
      label="syncSettings.relay"
      description={hint}
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
  )

  const secretRow = (
    <Setting
      label="syncSettings.secret"
      description={t(secretHint)}
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
          if (e.key === 'Escape' && !snapshot.vault) backOut()
        }}
      />
      <div className="settings-buttons">
        {snapshot.vault ? null : (
          <button type="button" className="button" onClick={backOut}>
            {t('dialog.cancel')}
          </button>
        )}
        <button
          type="button"
          className="button"
          disabled={secret.trim() === '' || creating || locked}
          onClick={create}
        >
          {t(snapshot.vault ? 'syncSettings.connect' : 'syncSettings.createVault')}
        </button>
      </div>
    </Setting>
  )
  const joinRows = (
    <JoinRows locked={locked} relayUrl={snapshot.relayUrl} onJoined={joined} failed={failed} />
  )
  const pathRow = (hint: MessageKey) => (
    <Setting label="syncSettings.setup" description={t(hint)}>
      <div className="settings-buttons">
        <button type="button" className="button" onClick={backOut}>
          {t('syncSettings.setupChange')}
        </button>
      </div>
    </Setting>
  )
  const setupRows = snapshot.enrolled ? null : held ? (
    <>
      {joinRows}
      {asksSecret ? secretRow : null}
    </>
  ) : path === 'first' ? (
    <>
      {pathRow('syncSettings.firstHint')}
      {relayRow(t('syncSettings.relayHint'))}
      {asksSecret ? secretRow : null}
    </>
  ) : path === 'another' ? (
    <>
      {pathRow('syncSettings.anotherHint')}
      {joinRows}
      {relayRow(t('syncSettings.relayJoinHint'))}
    </>
  ) : (
    <Setting label="syncSettings.setup" description={t('syncSettings.setupHint')}>
      <div className="settings-buttons">
        <button
          ref={firstButton}
          type="button"
          className="button"
          disabled={locked}
          onClick={() => choose('first')}
        >
          {t('syncSettings.setupFirst')}
        </button>
        <button
          type="button"
          className="button"
          disabled={locked}
          onClick={() => choose('another')}
        >
          {t('syncSettings.setupAnother')}
        </button>
      </div>
    </Setting>
  )
  const stateNotes = (
    <>
      {snapshot.enabled && snapshot.status.relayOutdated ? (
        <SettingsNote>{t('syncSettings.relayOutdated')}</SettingsNote>
      ) : null}
      {snapshot.enabled &&
      snapshot.status.unsyncedFiles &&
      !(
        snapshot.status.relayOutdated &&
        snapshot.status.unsyncedFiles.code === 'E_SYNC_RELAY_OUTDATED'
      ) ? (
        <SettingsNote>
          {snapshot.status.unsyncedFiles.code === 'E_SYNC_RELAY_OUTDATED'
            ? countOf(
                snapshot.status.unsyncedFiles.count,
                locale,
                'syncSettings.filesOutdatedOne',
                'syncSettings.filesOutdatedOther',
              )
            : countOf(
                snapshot.status.unsyncedFiles.count,
                locale,
                'syncSettings.filesFullOne',
                'syncSettings.filesFullOther',
              )}
        </SettingsNote>
      ) : null}
      {snapshot.enabled && snapshot.status.tooLarge > 0 ? (
        <SettingsNote>
          {countOf(
            snapshot.status.tooLarge,
            locale,
            'syncSettings.tooLargeOne',
            'syncSettings.tooLargeOther',
          )}
        </SettingsNote>
      ) : null}
      {snapshot.enabled && snapshot.status.skipped > 0 ? (
        <SettingsNote>
          {countOf(
            snapshot.status.skipped,
            locale,
            'syncSettings.skippedOne',
            'syncSettings.skippedOther',
          )}
        </SettingsNote>
      ) : null}
    </>
  )

  if (onPhone) {
    const shown = snapshot.enabled ? snapshot.status.state : 'off'
    const footnote = !snapshot.enabled
      ? t('phone.sync.notesStay')
      : snapshot.status.lastSync === null
        ? t('syncSettings.neverSynced')
        : format(t('phone.sync.lastSynced'), {
            time: new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(
              snapshot.status.lastSync,
            ),
          })
    return (
      <section ref={root} className="settings-section" aria-labelledby="sync-title">
        {header}
        <PhoneGroup footnote={footnote}>
          {lockedRow}
          <SettingToggle
            label="syncSettings.enabled"
            description="phone.sync.hint"
            checked={snapshot.enabled}
            disabled={snapshot.relayUrl === ''}
            onChange={(on) =>
              void changeSync({ enabled: on }).then(
                () => setError(undefined),
                failed('syncSettings.changeFailed'),
              )
            }
          />
          {snapshot.enrolled || held ? relayRow(t('phone.sync.relayHint')) : null}
          {shown === 'idle' || shown === 'off' ? null : (
            <Setting
              live
              label="syncSettings.status"
              description={statusText(snapshot, pauseOver, locale)}
            >
              {null}
            </Setting>
          )}
          {stateNotes}
        </PhoneGroup>
        {snapshot.enrolled ? (
          <PhoneGroup>
            <UsageRows snapshot={snapshot} />
          </PhoneGroup>
        ) : null}
        {recoveryKey ? <PhoneGroup>{recoveryPanel}</PhoneGroup> : null}
        {snapshot.enrolled ? null : <PhoneGroup>{setupRows}</PhoneGroup>}
        {snapshot.enrolled ? (
          <PhoneGroup>
            <DevicesRow refresh={devicesVersion} onAnnounce={announce} failed={failed} />
          </PhoneGroup>
        ) : null}
        {snapshot.enrolled ? (
          <PhoneGroup>
            <PairingRow
              locked={locked}
              focusRequest={focusPairing}
              onDevicesChanged={devicesChanged}
              onAnnounce={announce}
              failed={failed}
            />
          </PhoneGroup>
        ) : null}
        {snapshot.enrolled && !recoveryKey ? (
          <PhoneGroup>
            <Setting label="syncSettings.recovery" description={t('phone.sync.recoveryHint')}>
              {null}
            </Setting>
          </PhoneGroup>
        ) : null}
      </section>
    )
  }

  return (
    <section ref={root} className="settings-section" aria-labelledby="sync-title">
      {header}
      <SettingsSection title="syncSettings.title">
        <SettingsNote>{t('syncSettings.detail')}</SettingsNote>
        {lockedRow}
        {snapshot.enrolled || held ? relayRow(t('syncSettings.relayHint')) : null}
        {recoveryPanel}
        {setupRows}
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
        <Setting label="syncSettings.status" description={statusText(snapshot, pauseOver, locale)}>
          {null}
        </Setting>
        {stateNotes}
        <UsageRows snapshot={snapshot} />
        {snapshot.enrolled ? (
          <>
            <PairingRow
              locked={locked}
              focusRequest={focusPairing}
              onDevicesChanged={devicesChanged}
              onAnnounce={announce}
              failed={failed}
            />
            <DevicesRow refresh={devicesVersion} onAnnounce={announce} failed={failed} />
          </>
        ) : null}
      </SettingsSection>
    </section>
  )
}
