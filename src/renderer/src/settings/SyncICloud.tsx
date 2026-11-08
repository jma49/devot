import { useEffect, useId, useRef, useState, type Ref } from 'react'
import { errorCode } from '../backups'
import { ConfirmDialog } from '../ConfirmDialog'
import { fileSize } from '../format'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { changeSync, type SyncSnapshot } from '../sync'
import {
  answerICloudJoin,
  icloudStoredBytes,
  leaveICloudVault,
  syncThroughICloud,
  uploadToICloudAgain,
  type ICloudAction,
  type ICloudStatus,
} from '../syncICloud'
import { Setting, SettingsNote } from './controls'
import type { Failure } from './SyncDevices'
import { failureText, logFailure } from './syncWhy'

// Settings > Sync for a vault on iCloud, and the question a device with none answers first
// (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md).

const ACTION_LABELS: Readonly<Record<ICloudAction, MessageKey>> = {
  moveHere: 'syncSettings.icloudMoveToThisAccount',
  uploadAgain: 'syncSettings.icloudUploadAgain',
  turnOff: 'syncSettings.turnOff',
  follow: 'syncSettings.vaultMovedFollow',
  finish: 'syncSettings.vaultMovedFinish',
  join: 'syncSettings.icloudJoin',
  decline: 'syncSettings.icloudDecline',
}

const CONFIRMS: Partial<
  Readonly<Record<ICloudAction, { message: MessageKey; detail: MessageKey; confirm: MessageKey }>>
> = {
  moveHere: {
    message: 'syncSettings.icloudMoveConfirm',
    detail: 'syncSettings.icloudMoveDetail',
    confirm: 'syncSettings.icloudMoveButton',
  },
  uploadAgain: {
    message: 'syncSettings.icloudUploadConfirm',
    detail: 'syncSettings.icloudUploadDetail',
    confirm: 'syncSettings.icloudUploadButton',
  },
}

const RUN: Readonly<Record<ICloudAction, () => Promise<unknown>>> = {
  moveHere: uploadToICloudAgain,
  uploadAgain: uploadToICloudAgain,
  turnOff: () => changeSync({ enabled: false }),
  follow: () => syncThroughICloud(),
  finish: () => syncThroughICloud(),
  join: () => answerICloudJoin(true),
  decline: () => answerICloudJoin(false),
}

/** What the owner can do about an iCloud state: each a button, the ones that upload all confirmed. */
export function ICloudActions(props: {
  actions: readonly ICloudAction[]
  locked: boolean
  failed: Failure
  cleared: () => void
}) {
  const [confirming, setConfirming] = useState<ICloudAction>()
  const [running, setRunning] = useState(false)
  const run = (action: ICloudAction) => {
    setConfirming(undefined)
    if (running) return
    setRunning(true)
    RUN[action]()
      .then(props.cleared)
      .catch(props.failed('syncSettings.icloudChangeFailed'))
      .finally(() => setRunning(false))
  }
  if (props.actions.length === 0) return null
  const asked = confirming ? CONFIRMS[confirming] : undefined
  return (
    <div className="settings-buttons">
      {props.actions.map((action) => (
        <button
          key={action}
          type="button"
          className="button"
          disabled={running || (props.locked && action !== 'turnOff' && action !== 'decline')}
          onClick={() => (CONFIRMS[action] ? setConfirming(action) : run(action))}
        >
          {t(ACTION_LABELS[action])}
          {CONFIRMS[action] ? '…' : null}
        </button>
      ))}
      {confirming && asked ? (
        <ConfirmDialog
          message={t(asked.message)}
          detail={t(asked.detail)}
          confirm={t(asked.confirm)}
          onConfirm={() => run(confirming)}
          onCancel={() => setConfirming(undefined)}
        />
      ) : null}
    </div>
  )
}

const ACCOUNT_LINES: Readonly<Record<string, MessageKey>> = {
  noAccount: 'syncSettings.icloudSignedOut',
  restricted: 'syncSettings.icloudRestricted',
  temporarilyUnavailable: 'syncSettings.icloudTemporarilyUnavailable',
}

/**
 * The first question on a device with no vault: iCloud, or a relay under the advanced choice. A
 * signed-out or restricted account says so and keeps the iCloud button off.
 */
export function TransportQuestion({
  ref,
  ...props
}: {
  ref?: Ref<HTMLButtonElement>
  icloud: ICloudStatus
  locked: boolean
  declined: boolean
  onRelay: () => void
  failed: Failure
  cleared: () => void
}) {
  const [starting, setStarting] = useState(false)
  const blocked = props.icloud.account === 'available' ? undefined : props.icloud.account
  const line = blocked
    ? ACCOUNT_LINES[blocked]
    : props.declined
      ? 'syncSettings.icloudDeclined'
      : 'syncSettings.transportQuestionHint'
  const start = () => {
    if (starting || props.locked) return
    setStarting(true)
    ;(props.declined ? answerICloudJoin(true) : syncThroughICloud())
      .then(props.cleared)
      .catch(props.failed('syncSettings.icloudChangeFailed'))
      .finally(() => setStarting(false))
  }
  return (
    <Setting
      label="syncSettings.setup"
      description={t(line ?? 'syncSettings.transportQuestionHint')}
    >
      <div className="settings-buttons">
        <button
          ref={ref}
          type="button"
          className="button"
          disabled={starting || props.locked || blocked !== undefined}
          onClick={start}
        >
          {t(props.declined ? 'syncSettings.icloudJoin' : 'syncSettings.useIcloud')}
        </button>
        <button type="button" className="button" disabled={props.locked} onClick={props.onRelay}>
          {t('syncSettings.transportRelayAdvanced')}
        </button>
      </div>
    </Setting>
  )
}

/** Where the vault syncs; on a relay chosen over iCloud, the way back to the question. */
export function TransportRow(props: { snapshot: SyncSnapshot; onICloud?: () => void }) {
  const icloud = props.snapshot.vault && props.snapshot.transport === 'icloud'
  return (
    <Setting
      label="syncSettings.transport"
      description={t(icloud ? 'syncSettings.transportIcloud' : 'syncSettings.transportRelay')}
    >
      {props.onICloud ? (
        <div className="settings-buttons">
          <button type="button" className="button" onClick={props.onICloud}>
            {t('syncSettings.useIcloudInstead')}
          </button>
        </div>
      ) : null}
    </Setting>
  )
}

/** A relay vault's way to iCloud: confirmed, then a new epoch there and the moved marker here. */
export function MoveToICloudRow(props: { locked: boolean; failed: Failure; cleared: () => void }) {
  const [asking, setAsking] = useState(false)
  const [moving, setMoving] = useState(false)
  const move = () => {
    setAsking(false)
    if (moving) return
    setMoving(true)
    syncThroughICloud()
      .then(props.cleared)
      .catch(props.failed('syncSettings.icloudChangeFailed'))
      .finally(() => setMoving(false))
  }
  return (
    <Setting
      label="syncSettings.switchTransport"
      description={t('syncSettings.switchTransportHint')}
    >
      <div className="settings-buttons">
        <button
          type="button"
          className="button"
          disabled={moving || props.locked}
          onClick={() => setAsking(true)}
        >
          {`${t('syncSettings.switchTransport')}…`}
        </button>
      </div>
      {asking ? (
        <ConfirmDialog
          message={t('syncSettings.switchTransportConfirm')}
          detail={t('syncSettings.switchTransportDetail')}
          confirm={t('syncSettings.switchTransportButton')}
          onConfirm={move}
          onCancel={() => setAsking(false)}
        />
      ) : null}
    </Setting>
  )
}

type Stored =
  | { state: 'reading' }
  | { state: 'ready'; bytes: number }
  | { state: 'failed'; code: string }

/** What the vault takes in iCloud, added up here: Devot never reads the account's own storage. */
export function ICloudStorageRows(props: { snapshot: SyncSnapshot }) {
  const [stored, setStored] = useState<Stored>({ state: 'reading' })
  const { lastSync } = props.snapshot.status
  useEffect(() => {
    let current = true
    icloudStoredBytes().then(
      (bytes) => {
        if (current) setStored({ state: 'ready', bytes })
      },
      (e: unknown) => {
        if (current) setStored({ state: 'failed', code: logFailure(errorCode(e)) })
      },
    )
    return () => {
      current = false
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each sync may change what the vault takes, so it is added up again.
  }, [lastSync])
  const text =
    stored.state === 'ready'
      ? format(t('syncSettings.icloudStorageValue'), {
          size: fileSize(stored.bytes, currentLocale()),
        })
      : stored.state === 'failed'
        ? failureText('syncSettings.icloudStorageFailed', stored.code)
        : t('syncSettings.icloudStorageReading')
  return (
    <>
      <Setting label="syncSettings.icloudStorage" description={text}>
        {null}
      </Setting>
      <SettingsNote>{t('syncSettings.icloudStorageManaged')}</SettingsNote>
    </>
  )
}

/**
 * Removes the vault from this Apple ID. Typing its recovery key is the confirmation: Rust refuses
 * a key of another vault, and the notes stay on every device.
 */
export function LeaveICloudRow(props: { onLeft: () => void; failed: Failure }) {
  const ids = useId()
  const [asking, setAsking] = useState(false)
  const [key, setKey] = useState('')
  const [leaving, setLeaving] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const { onLeft, failed } = props
  useEffect(() => {
    if (asking) field.current?.focus()
  }, [asking])
  const cancel = () => {
    setAsking(false)
    setKey('')
    requestAnimationFrame(() => opener.current?.focus())
  }
  const leave = () => {
    if (key.trim() === '' || leaving) return
    setLeaving(true)
    leaveICloudVault(key)
      .then(() => {
        setKey('')
        setAsking(false)
        onLeft()
      }, failed('syncSettings.icloudLeaveFailed'))
      .finally(() => setLeaving(false))
  }
  if (!asking)
    return (
      <Setting label="syncSettings.icloudLeave" description={t('syncSettings.icloudLeaveHint')}>
        <div className="settings-buttons">
          <button
            ref={opener}
            type="button"
            className="button"
            data-destructive
            onClick={() => setAsking(true)}
          >
            {`${t('syncSettings.icloudLeave')}…`}
          </button>
        </div>
      </Setting>
    )
  const hint = t('syncSettings.icloudLeaveKeyHint')
  const hintId = hint === '' ? undefined : `${ids}-hint`
  return (
    <Setting
      label="syncSettings.icloudLeaveKey"
      description={hint}
      htmlFor={`${ids}-key`}
      descriptionId={hintId}
    >
      <input
        ref={field}
        id={`${ids}-key`}
        type="text"
        className="settings-number settings-text"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="characters"
        value={key}
        aria-describedby={hintId}
        onChange={(e) => setKey(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') leave()
          if (e.key === 'Escape') cancel()
        }}
      />
      <div className="settings-buttons">
        <button type="button" className="button" disabled={leaving} onClick={cancel}>
          {t('dialog.cancel')}
        </button>
        <button
          type="button"
          className="button"
          data-destructive
          disabled={key.trim() === '' || leaving}
          onClick={leave}
        >
          {t('syncSettings.icloudLeaveButton')}
        </button>
      </div>
    </Setting>
  )
}
