import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { errorCode } from '../backups'
import { QUOTA } from '../../../core/sync/transport'
import { countOf, untilTime, uploadCounts } from '../format'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { licenceEntitlements, startLicence, useLicence, useTrialOver } from '../licence'
import { LicenceButton } from '../LicenceLocked'
import { lockedSentence } from '../licenceView'
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
import { icloudAttention, icloudLine, icloudWordsCode, useICloudStatus } from '../syncICloud'
import { PhoneGroup } from '../phone/PhoneControls'
import { Setting, SettingToggle, SettingsNote, SettingsSection } from './controls'
import { useOnPhone } from './onPhone'
import { DevicesRow, JoinRows, PairingRow, RecoveryKeyPanel } from './SyncDevices'
import { LeaveVaultRow } from './SyncLeave'
import { ICloudRotateKeyRow, RotateKeyRow } from './SyncRotate'
import {
  ICloudActions,
  ICloudStorageRows,
  LeaveICloudRow,
  MoveToICloudRow,
  TransportQuestion,
  TransportRow,
} from './SyncICloud'
import { UsageRows } from './SyncUsage'
import { failureText, logFailure } from './syncWhy'
import { failureReason } from '../failure'

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
  const { state, code, pausedUntil } = snapshot.status
  const shown = snapshot.enabled ? state : 'off'
  const parts = [
    shown === 'paused' && pausedUntil !== null
      ? pauseText(pausedUntil, pauseOver, locale, code)
      : t(STATES[shown]),
  ]
  const words = shown === 'stopped' && code ? (STOP_ADVICE[code] ?? REVOKED_WORDS[code]) : undefined
  if (words) parts.push(t(words))
  return [...parts, ...statusDetails(snapshot, locale)].join(' ')
}

const REVOKED_WORDS: Readonly<Record<string, MessageKey>> = {
  E_SYNC_REVOKED: 'syncSettings.stoppedRevoked',
  E_SYNC_UNAUTHORIZED: 'syncSettings.stoppedRevoked',
}
const UNREACHABLE = new Set(['E_SYNC_OFFLINE', 'E_SYNC_RELAY_FAILED'])

/** True when the status row shows words for the code in this state, so no code goes beside them. */
function wordedCode(snapshot: SyncSnapshot): boolean {
  const { state, code, pausedUntil } = snapshot.status
  if (!code) return false
  if (icloudWordsCode(snapshot)) return true
  switch (state) {
    case 'stopped':
      return code in STOP_ADVICE || code in REVOKED_WORDS
    case 'paused':
      return pausedUntil !== null && (code === STORAGE_FULL || code === QUOTA)
    case 'offline':
      return UNREACHABLE.has(code)
    default:
      return false
  }
}

function statusDetails(snapshot: SyncSnapshot, locale: string): string[] {
  const { state, lastSync, code, upload } = snapshot.status
  const parts: string[] = []
  if (upload && snapshot.enabled)
    parts.push(format(t('syncSettings.upload'), uploadCounts(upload, locale)))
  const reason = code ? failureReason(code) : undefined
  if (reason && snapshot.enabled && state !== 'idle' && !wordedCode(snapshot)) parts.push(t(reason))
  parts.push(
    lastSync === null
      ? t('syncSettings.neverSynced')
      : format(t('syncSettings.lastSync'), { time: when(lastSync, locale) }),
  )
  return parts
}

/** iCloud states shown in the setup rows or a note rather than the status row. */
const OUTSIDE_STATUS = new Set(['ask', 'fallback', 'joined'])

// On iCloud the other devices follow on their own, and a rotation that lost the race comes back
// without a recovery key: this device followed the one that won.
function rotatedMessage(onICloud: boolean, madeHere: boolean): MessageKey {
  if (!onICloud) return 'syncSettings.rotated'
  return madeHere ? 'syncSettings.rotatedIcloud' : 'syncSettings.rotatedIcloudFollowed'
}

/**
 * Settings > Sync: iCloud or a relay first (a build without the container offers only the relay).
 * For a vault on iCloud: its state and what to do about it, storage and devices. For a relay: the
 * relay's URL, joining with a pairing code or the recovery key, or on the first device only
 * creating the vault with the relay's secret (asked once and never kept), the recovery key until
 * it is saved, showing a pairing code, the vault's devices, sync on or off and its status.
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
  const [relayChosen, setRelayChosen] = useState<boolean>()
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
  const licence = useLicence()
  const trialEnded = useTrialOver()
  const locked = !licenceEntitlements.has('sync')

  const icloud = useICloudStatus(snapshot)
  const onICloud = snapshot.vault && snapshot.transport === 'icloud'
  const inVault = snapshot.enrolled || onICloud
  // Another device changed the key: only its successor can be joined, and no code is shown.
  const rotatedAway = snapshot.rotated || snapshot.status.code === 'E_SYNC_VAULT_ROTATED'
  const attention = icloudAttention(snapshot)
  const line = attention ? icloudLine(attention, snapshot, icloud, pauseOver) : undefined
  const statusLine = attention && line && !OUTSIDE_STATUS.has(attention.kind) ? line : undefined
  // A device partway through a relay's setup has the relay's address already.
  const onRelayPath = relayChosen ?? snapshot.relayUrl !== ''
  const asksTransport = icloud.available && !snapshot.vault && !onRelayPath

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
      setError({ message, code: logFailure(errorCode(e)), n: failures.current })
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
  const cleared = useCallback(() => setError(undefined), [])
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
    if (!inVault) return
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
  }, [inVault])

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
  const held = !snapshot.enrolled && snapshot.vault && !onICloud
  const asksSecret = needsVault && (held || path === 'first')
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
          {failureText(error.message, error.code)}
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
          description={lockedSentence('sync', licence, trialEnded)}
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
          icloud={onICloud}
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
  const rotatedRows = !rotatedAway ? null : onICloud ? (
    <>
      <SettingsNote>{t('syncSettings.rotatedAwayIcloud')}</SettingsNote>
      <JoinRows
        locked={locked}
        relayUrl={snapshot.relayUrl}
        via="icloud"
        onJoined={joined}
        failed={failed}
      />
    </>
  ) : (
    <>
      <SettingsNote>{t('syncSettings.rotatedAway')}</SettingsNote>
      {joinRows}
    </>
  )
  const rotated = (key: string | null) => {
    if (key) {
      setRecoveryKey(key)
      setKeyFocus(true)
    }
    announce(t(rotatedMessage(onICloud, key !== null)))
  }
  const pathRow = (hint: MessageKey) => (
    <Setting label="syncSettings.setup" description={t(hint)}>
      <div className="settings-buttons">
        <button type="button" className="button" onClick={backOut}>
          {t('syncSettings.setupChange')}
        </button>
      </div>
    </Setting>
  )
  const chooseRelay = () => setRelayChosen(true)
  const relayButton = (
    <button type="button" className="button" disabled={locked} onClick={chooseRelay}>
      {t('syncSettings.transportRelayAdvanced')}
    </button>
  )
  const icloudSetup =
    attention?.kind === 'ask' && line ? (
      <Setting label="syncSettings.setup" description={line.text}>
        <ICloudActions actions={line.actions} locked={locked} failed={failed} cleared={cleared} />
      </Setting>
    ) : attention?.kind === 'fallback' && line ? (
      <>
        <Setting label="syncSettings.setup" description={line.text}>
          <div className="settings-buttons">{relayButton}</div>
        </Setting>
        <JoinRows
          locked={locked}
          relayUrl={snapshot.relayUrl}
          via="icloud"
          onJoined={joined}
          failed={failed}
        />
      </>
    ) : (
      <TransportQuestion
        icloud={icloud}
        locked={locked}
        declined={snapshot.icloudJoin?.state === 'declined'}
        ref={firstButton}
        onRelay={chooseRelay}
        failed={failed}
        cleared={cleared}
      />
    )
  const relaySetupRows = snapshot.enrolled ? null : held ? (
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
  const setupRows = inVault ? null : asksTransport ? (
    icloudSetup
  ) : icloud.available && !snapshot.vault ? (
    <>
      <TransportRow snapshot={snapshot} onICloud={() => setRelayChosen(false)} />
      {relaySetupRows}
    </>
  ) : (
    relaySetupRows
  )
  const statusDescription = !statusLine
    ? statusText(snapshot, pauseOver, locale)
    : snapshot.enabled
      ? [statusLine.text, ...statusDetails(snapshot, locale)].join(' ')
      : statusLine.text
  const statusActions = statusLine ? (
    <ICloudActions actions={statusLine.actions} locked={locked} failed={failed} cleared={cleared} />
  ) : null
  const showsTransport = onICloud || (snapshot.enrolled && icloud.available)
  const offersICloud =
    snapshot.enrolled &&
    !onICloud &&
    icloud.account === 'available' &&
    attention?.kind !== 'moved' &&
    attention?.kind !== 'movedHere'
  const joinedNote =
    attention?.kind === 'joined' && line ? <SettingsNote>{line.text}</SettingsNote> : null
  const toggleOff = !onICloud && snapshot.relayUrl === ''
  const leaveRow = onICloud ? (
    <LeaveICloudRow onLeft={() => announce(t('syncSettings.icloudLeft'))} failed={failed} />
  ) : snapshot.vault ? (
    <LeaveVaultRow onLeft={() => announce(t('syncSettings.left'))} failed={failed} />
  ) : null
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
    const pairingRow = (
      <PairingRow
        icloud={onICloud}
        locked={locked}
        focusRequest={focusPairing}
        onDevicesChanged={devicesChanged}
        onAnnounce={announce}
        failed={failed}
      />
    )
    return (
      <section ref={root} className="settings-section" aria-labelledby="sync-title">
        {header}
        <PhoneGroup footnote={footnote}>
          {lockedRow}
          {joinedNote}
          <SettingToggle
            label="syncSettings.enabled"
            description="phone.sync.hint"
            checked={snapshot.enabled}
            disabled={toggleOff}
            onChange={(on) =>
              void changeSync({ enabled: on }).then(
                () => setError(undefined),
                failed('syncSettings.changeFailed'),
              )
            }
          />
          {showsTransport ? <TransportRow snapshot={snapshot} /> : null}
          {(snapshot.enrolled || held) && !onICloud ? relayRow(t('phone.sync.relayHint')) : null}
          {statusLine || !(shown === 'idle' || shown === 'off') ? (
            <Setting label="syncSettings.status" description={statusDescription}>
              {statusActions}
            </Setting>
          ) : null}
          {stateNotes}
        </PhoneGroup>
        {onICloud ? (
          <PhoneGroup footnote={t('syncSettings.icloudStorageManaged')}>
            <ICloudStorageRows snapshot={snapshot} />
          </PhoneGroup>
        ) : snapshot.enrolled ? (
          <PhoneGroup>
            <UsageRows snapshot={snapshot} />
          </PhoneGroup>
        ) : null}
        {offersICloud ? (
          <PhoneGroup>
            <MoveToICloudRow locked={locked} failed={failed} cleared={cleared} />
          </PhoneGroup>
        ) : null}
        {recoveryKey ? <PhoneGroup>{recoveryPanel}</PhoneGroup> : null}
        {inVault ? null : <PhoneGroup anchor="pairing">{setupRows}</PhoneGroup>}
        {inVault ? (
          <PhoneGroup>
            <DevicesRow
              icloud={onICloud}
              refresh={devicesVersion}
              onAnnounce={announce}
              failed={failed}
            />
          </PhoneGroup>
        ) : null}
        {rotatedRows ? <PhoneGroup>{rotatedRows}</PhoneGroup> : null}
        {inVault && !rotatedAway ? <PhoneGroup anchor="pairing">{pairingRow}</PhoneGroup> : null}
        {leaveRow ? <PhoneGroup>{leaveRow}</PhoneGroup> : null}
      </section>
    )
  }

  return (
    <section ref={root} className="settings-section" aria-labelledby="sync-title">
      {header}
      <SettingsSection title="syncSettings.title">
        <SettingsNote>
          {t(onICloud ? 'syncSettings.icloudDetail' : 'syncSettings.detail')}
        </SettingsNote>
        {lockedRow}
        {joinedNote}
        {showsTransport ? <TransportRow snapshot={snapshot} /> : null}
        {(snapshot.enrolled || held) && !onICloud ? relayRow(t('syncSettings.relayHint')) : null}
        {recoveryPanel}
        {setupRows}
        <SettingToggle
          label="syncSettings.enabled"
          description={onICloud ? 'syncSettings.enabledHintIcloud' : 'syncSettings.enabledHint'}
          checked={snapshot.enabled}
          disabled={toggleOff}
          onChange={(on) =>
            void changeSync({ enabled: on }).then(
              () => setError(undefined),
              failed('syncSettings.changeFailed'),
            )
          }
        />
        <Setting label="syncSettings.status" description={statusDescription}>
          {statusActions}
        </Setting>
        {stateNotes}
        {onICloud ? <ICloudStorageRows snapshot={snapshot} /> : <UsageRows snapshot={snapshot} />}
        {offersICloud ? (
          <MoveToICloudRow locked={locked} failed={failed} cleared={cleared} />
        ) : null}
        {rotatedRows}
        {inVault ? (
          <>
            {rotatedAway ? null : (
              <PairingRow
                icloud={onICloud}
                locked={locked}
                focusRequest={focusPairing}
                onDevicesChanged={devicesChanged}
                onAnnounce={announce}
                failed={failed}
              />
            )}
            <DevicesRow
              icloud={onICloud}
              refresh={devicesVersion}
              onAnnounce={announce}
              failed={failed}
            />
          </>
        ) : null}
        {rotatedAway ? null : onICloud ? (
          <ICloudRotateKeyRow onRotated={rotated} failed={failed} />
        ) : snapshot.enrolled ? (
          <RotateKeyRow onRotated={rotated} failed={failed} />
        ) : null}
        {leaveRow}
      </SettingsSection>
    </section>
  )
}
