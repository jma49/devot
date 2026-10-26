import { useEffect, useId, useRef, useState } from 'react'
import { errorCode } from '../backups'
import { writeClipboardText } from '../clipboard'
import { ConfirmDialog } from '../ConfirmDialog'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import {
  cancelPairing,
  checkPairing,
  joinWithCode,
  joinWithRecoveryKey,
  listDevices,
  openPairing,
  removeDevice,
  type ShownPairing,
  type SyncDevice,
} from '../sync'
import { Setting } from './controls'

// Settings > Sync's pairing, joining and devices (docs/adr/0008-sync-device-pairing.md). Rust holds
// every key; the page shows a pairing code while it is on show and the recovery key once.

export type Failure = (message: MessageKey) => (e: unknown) => void

const POLL_MS = 2_000
const QUIET_MODULES = 4

const day = (at: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(at)

function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function QrCode({ qr }: { qr: ShownPairing['qr'] }) {
  const total = qr.size + QUIET_MODULES * 2
  let path = ''
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y * qr.size + x] === '1') {
        path += `M${x + QUIET_MODULES} ${y + QUIET_MODULES}h1v1h-1z`
      }
    }
  }
  return (
    <svg
      className="pairing-qr"
      viewBox={`0 0 ${total} ${total}`}
      role="img"
      aria-label={t('syncSettings.pairQr')}
      shapeRendering="crispEdges"
    >
      <rect className="pairing-qr-ground" width={total} height={total} />
      <path className="pairing-qr-modules" d={path} />
    </svg>
  )
}

/** The recovery key, shown once after turning sync on made the vault. */
export function RecoveryKeyPanel(props: {
  recoveryKey: string
  onDone: () => void
  onAnnounce: (text: string) => void
  failed: Failure
}) {
  const copy = () =>
    void writeClipboardText(props.recoveryKey).then(
      () => props.onAnnounce(t('syncSettings.recoveryCopied')),
      props.failed('syncSettings.copyFailed'),
    )
  return (
    <Setting label="syncSettings.recovery" description={t('syncSettings.recoveryHint')}>
      <pre className="integration-config recovery-key" aria-label={t('syncSettings.recovery')}>
        <code>{props.recoveryKey}</code>
      </pre>
      <div className="settings-buttons">
        <button type="button" className="button" onClick={copy}>
          {t('syncSettings.recoveryCopy')}
        </button>
        <button type="button" className="button" onClick={props.onDone}>
          {t('syncSettings.recoverySaved')}
        </button>
      </div>
    </Setting>
  )
}

type Progress = 'waiting' | 'taken'

/** Add a Device: a pairing code with its QR code and countdown, until a device joins or it ends. */
export function PairingRow(props: {
  locked: boolean
  onPaired: () => void
  onAnnounce: (text: string) => void
  failed: Failure
}) {
  const [shown, setShown] = useState<ShownPairing>()
  const [progress, setProgress] = useState<Progress>('waiting')
  const [ended, setEnded] = useState<MessageKey>()
  const [now, setNow] = useState(Date.now)
  const [opening, setOpening] = useState(false)
  const open = useRef(false)
  const { onPaired, onAnnounce, failed } = props

  useEffect(() => {
    if (!shown) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const end = (message?: MessageKey) => {
      stopped = true
      open.current = false
      setShown(undefined)
      setEnded(message)
    }
    const check = () => {
      checkPairing().then(
        (state) => {
          if (stopped) return
          if (state.state === 'paired') {
            end()
            onAnnounce(t('syncSettings.pairDone'))
            onPaired()
          } else if (state.state === 'expired') {
            end('syncSettings.pairExpired')
          } else {
            setProgress(state.state)
            timer = setTimeout(check, POLL_MS)
          }
        },
        (e: unknown) => {
          if (stopped) return
          end()
          failed('syncSettings.pairCheckFailed')(e)
        },
      )
    }
    timer = setTimeout(check, POLL_MS)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      stopped = true
      clearTimeout(timer)
      clearInterval(tick)
    }
  }, [shown, onPaired, onAnnounce, failed])

  // A code on show when Settings closes stops working.
  useEffect(
    () => () => {
      if (open.current) void cancelPairing().catch(() => undefined)
    },
    [],
  )

  const show = () => {
    if (opening || props.locked) return
    setOpening(true)
    setEnded(undefined)
    openPairing()
      .then((next) => {
        open.current = true
        setProgress('waiting')
        setNow(Date.now())
        setShown(next)
      }, failed('syncSettings.pairFailed'))
      .finally(() => setOpening(false))
  }

  const cancel = () => {
    open.current = false
    setShown(undefined)
    void cancelPairing().catch(() => undefined)
  }

  return (
    <Setting label="syncSettings.pair" description={ended ? t(ended) : t('syncSettings.pairHint')}>
      {shown ? (
        <div className="pairing">
          <QrCode qr={shown.qr} />
          <p className="pairing-code" aria-label={t('syncSettings.pairCode')}>
            {shown.code}
          </p>
          <p className="settings-hint" role="status">
            {t(progress === 'taken' ? 'syncSettings.pairTaken' : 'syncSettings.pairWaiting')}{' '}
            {format(t('syncSettings.pairExpiresIn'), { time: countdown(shown.expires - now) })}
          </p>
          <div className="settings-buttons">
            <button type="button" className="button" onClick={cancel}>
              {t('dialog.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="settings-buttons">
          <button
            type="button"
            className="button"
            disabled={opening || props.locked}
            onClick={show}
          >
            {t('syncSettings.pairShow')}
          </button>
        </div>
      )}
    </Setting>
  )
}

/** Join With a Code and Join With Recovery Key, for a device that is not in a vault yet. */
export function JoinRows(props: { locked: boolean; onJoined: () => void; failed: Failure }) {
  const ids = useId()
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState('')
  const [joining, setJoining] = useState(false)
  const { onJoined, failed } = props

  const join = (how: 'code' | 'recovery') => {
    const text = how === 'code' ? code : recovery
    if (text.trim() === '' || joining || props.locked) return
    setJoining(true)
    const joined = how === 'code' ? joinWithCode(text) : joinWithRecoveryKey(text)
    joined
      .then(() => {
        setCode('')
        setRecovery('')
        onJoined()
      }, failed('syncSettings.joinFailed'))
      .finally(() => setJoining(false))
  }

  const row = (
    how: 'code' | 'recovery',
    label: MessageKey,
    hint: MessageKey,
    value: string,
    set: (text: string) => void,
  ) => (
    <Setting
      label={label}
      description={t(hint)}
      htmlFor={`${ids}-${how}`}
      descriptionId={`${ids}-${how}-hint`}
    >
      <input
        id={`${ids}-${how}`}
        type="text"
        className="settings-number settings-text"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="characters"
        value={value}
        aria-describedby={`${ids}-${how}-hint`}
        onChange={(e) => set(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') join(how)
        }}
      />
      <div className="settings-buttons">
        <button
          type="button"
          className="button"
          aria-label={t(label)}
          disabled={value.trim() === '' || joining || props.locked}
          onClick={() => join(how)}
        >
          {t('syncSettings.join')}
        </button>
      </div>
    </Setting>
  )

  return (
    <>
      {row('code', 'syncSettings.joinCode', 'syncSettings.joinCodeHint', code, setCode)}
      {row(
        'recovery',
        'syncSettings.joinRecovery',
        'syncSettings.joinRecoveryHint',
        recovery,
        setRecovery,
      )}
    </>
  )
}

/** The vault's devices, this one marked; any other can be removed after a confirmation. */
export function DevicesRow(props: { onAnnounce: (text: string) => void; failed: Failure }) {
  const [devices, setDevices] = useState<SyncDevice[]>()
  const [problem, setProblem] = useState<string>()
  const [removing, setRemoving] = useState<SyncDevice>()
  const locale = currentLocale()
  const { onAnnounce, failed } = props

  useEffect(() => {
    let current = true
    listDevices().then(
      (list) => {
        if (!current) return
        setProblem(undefined)
        setDevices(list)
      },
      (e: unknown) => {
        if (current) setProblem(format(t('syncSettings.devicesFailed'), { code: errorCode(e) }))
      },
    )
    return () => {
      current = false
    }
  }, [])

  const remove = (device: SyncDevice) => {
    setRemoving(undefined)
    removeDevice(device.id).then((left) => {
      setDevices(left)
      onAnnounce(t('syncSettings.deviceRemoved'))
    }, failed('syncSettings.removeFailed'))
  }

  return (
    <>
      <Setting label="syncSettings.devices" description={problem ?? t('syncSettings.devicesHint')}>
        {null}
      </Setting>
      {devices && devices.length > 0 ? (
        <ul className="sync-devices" aria-label={t('syncSettings.devicesList')}>
          {devices.map((device) => {
            const added = format(t('syncSettings.deviceAdded'), {
              date: day(device.created, locale),
            })
            return (
              <li key={device.id} className="sync-device">
                <div className="setting-text">
                  <span className="setting-label">{device.label}</span>
                  <span className="setting-description">
                    {device.current ? `${added} · ${t('syncSettings.thisDevice')}` : added}
                  </span>
                </div>
                {device.current ? null : (
                  <button
                    type="button"
                    className="button"
                    aria-label={format(t('syncSettings.deviceRemoveLabel'), {
                      name: device.label,
                      date: day(device.created, locale),
                    })}
                    onClick={() => setRemoving(device)}
                  >
                    {t('syncSettings.deviceRemove')}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      ) : null}
      {removing ? (
        <ConfirmDialog
          message={t('syncSettings.deviceRemoveConfirm')}
          detail={t('syncSettings.deviceRemoveDetail')}
          confirm={t('syncSettings.deviceRemoveButton')}
          onConfirm={() => remove(removing)}
          onCancel={() => setRemoving(undefined)}
        />
      ) : null}
    </>
  )
}
