import { useEffect, useId, useRef, useState } from 'react'
import { errorCode } from '../backups'
import { writeClipboardSecret } from '../clipboard'
import { ConfirmDialog } from '../ConfirmDialog'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import {
  cancelPairing,
  changeSync,
  checkPairing,
  joinWithCode,
  joinWithRecoveryKey,
  linkRelay,
  listDevices,
  openPairing,
  relayAllowed,
  removeDevice,
  type ShownPairing,
  type SyncDevice,
} from '../sync'
import { Setting } from './controls'

// Settings > Sync's pairing, joining and devices (docs/adr/0008-sync-device-pairing.md). Rust holds
// every key; the page shows a pairing code while it is on show and the recovery key until saved.

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

/** The recovery key, on offer until this device says it was saved. */
export function RecoveryKeyPanel(props: {
  recoveryKey: string
  focus: boolean
  onDone: () => void
  onAnnounce: (text: string) => void
  failed: Failure
}) {
  const key = useRef<HTMLPreElement>(null)
  const { focus } = props
  useEffect(() => {
    if (focus) key.current?.focus()
  }, [focus])
  const copy = () =>
    void writeClipboardSecret(props.recoveryKey).then(
      () => props.onAnnounce(t('syncSettings.recoveryCopied')),
      props.failed('syncSettings.copyFailed'),
    )
  return (
    <Setting label="syncSettings.recovery" description={t('syncSettings.recoveryHint')} stacked>
      <pre
        ref={key}
        tabIndex={-1}
        className="integration-config recovery-key"
        aria-label={t('syncSettings.recovery')}
      >
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

// Polling goes on through these until the code expires; any other failure ends the pairing.
const TRANSIENT = new Set(['E_SYNC_OFFLINE', 'E_SYNC_RELAY_FAILED'])

/** Add a Device: a pairing code with its QR code and countdown, until a device joins or it ends. */
export function PairingRow(props: {
  locked: boolean
  /** Moves focus to Show Pairing Code each time it grows. */
  focusRequest: number
  /** A device joined, or may have enrolled without finishing. */
  onDevicesChanged: () => void
  onAnnounce: (text: string) => void
  failed: Failure
}) {
  const [shown, setShown] = useState<ShownPairing>()
  const [progress, setProgress] = useState<Progress>('waiting')
  const [unreachable, setUnreachable] = useState(false)
  const [ended, setEnded] = useState<MessageKey>()
  const [now, setNow] = useState(Date.now)
  const [opening, setOpening] = useState(false)
  const [closed, setClosed] = useState(0)
  const open = useRef(false)
  const showButton = useRef<HTMLButtonElement>(null)
  const code = useRef<HTMLParagraphElement>(null)
  const { onDevicesChanged, onAnnounce, failed, focusRequest } = props

  useEffect(() => {
    if (shown) code.current?.focus()
  }, [shown])

  useEffect(() => {
    if (closed + focusRequest > 0) showButton.current?.focus()
  }, [closed, focusRequest])

  useEffect(() => {
    if (!shown) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const end = (message?: MessageKey) => {
      stopped = true
      open.current = false
      setShown(undefined)
      setUnreachable(false)
      setEnded(message)
      setClosed((n) => n + 1)
      if (message) onAnnounce(t(message))
    }
    const check = () => {
      checkPairing().then(
        (state) => {
          if (stopped) return
          setUnreachable(false)
          if (state.state === 'paired') {
            end()
            onAnnounce(t('syncSettings.pairDone'))
            onDevicesChanged()
          } else if (state.state === 'expired') {
            end('syncSettings.pairExpired')
          } else if (state.state === 'unconfirmed') {
            end('syncSettings.pairUnconfirmed')
            onDevicesChanged()
          } else {
            setProgress(state.state)
            timer = setTimeout(check, POLL_MS)
          }
        },
        (e: unknown) => {
          if (stopped) return
          if (TRANSIENT.has(errorCode(e))) {
            setUnreachable(true)
            timer = setTimeout(check, POLL_MS)
            return
          }
          end()
          void cancelPairing().catch(() => undefined)
          failed('syncSettings.pairCheckFailed')(e)
          // The device that took the code may have enrolled before its proof failed.
          onDevicesChanged()
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
  }, [shown, onDevicesChanged, onAnnounce, failed])

  // Closing the window ends the code in Rust too (sync::on_window_event); this covers a pane switch.
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
    setUnreachable(false)
    setClosed((n) => n + 1)
    void cancelPairing().catch(() => undefined)
  }

  const progressText = unreachable
    ? 'syncSettings.pairRetrying'
    : progress === 'taken'
      ? 'syncSettings.pairTaken'
      : 'syncSettings.pairWaiting'

  return (
    <Setting label="syncSettings.pair" description={ended ? t(ended) : t('syncSettings.pairHint')}>
      {shown ? (
        <div
          className="pairing"
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancel()
          }}
        >
          <QrCode qr={shown.qr} />
          <div className="pairing-text">
            <p
              ref={code}
              tabIndex={-1}
              className="pairing-code"
              aria-label={t('syncSettings.pairCode')}
            >
              {shown.code}
            </p>
            <p className="settings-hint" role="status">
              {t(progressText)}
            </p>
            {shown.expires > now ? (
              <p className="settings-hint">
                {format(t('syncSettings.pairExpiresIn'), { time: countdown(shown.expires - now) })}
              </p>
            ) : null}
          </div>
          <div className="settings-buttons">
            <button type="button" className="button" onClick={cancel}>
              {t('dialog.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="settings-buttons">
          <button
            ref={showButton}
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

/**
 * Join With a Code and Join With Recovery Key, for a device that is not in a vault yet. A pasted
 * link that names a relay while none is set is joined only after the person agrees to that relay.
 */
export function JoinRows(props: {
  locked: boolean
  relayUrl: string
  onJoined: () => void
  failed: Failure
}) {
  const ids = useId()
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState('')
  const [joining, setJoining] = useState(false)
  const [askRelay, setAskRelay] = useState<string>()
  const { onJoined, failed } = props

  const send = (joined: () => Promise<unknown>) => {
    setJoining(true)
    joined()
      .then(() => {
        setCode('')
        setRecovery('')
        onJoined()
      }, failed('syncSettings.joinFailed'))
      .finally(() => setJoining(false))
  }

  const join = (how: 'code' | 'recovery') => {
    const text = how === 'code' ? code : recovery
    if (text.trim() === '' || joining || props.locked) return
    if (how === 'recovery') return send(() => joinWithRecoveryKey(text))
    const named = props.relayUrl === '' ? linkRelay(text) : undefined
    if (named && !relayAllowed(named))
      return failed('syncSettings.joinFailed')('E_SYNC_RELAY_URL_INVALID')
    if (named) return setAskRelay(named)
    send(() => joinWithCode(text))
  }

  const joinOnRelay = (relay: string) => {
    setAskRelay(undefined)
    send(() => changeSync({ relayUrl: relay }).then(() => joinWithCode(code)))
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
      {askRelay ? (
        <ConfirmDialog
          message={format(t('syncSettings.linkRelayConfirm'), { host: new URL(askRelay).host })}
          detail={t('syncSettings.linkRelayDetail')}
          confirm={t('syncSettings.linkRelayButton')}
          onConfirm={() => joinOnRelay(askRelay)}
          onCancel={() => setAskRelay(undefined)}
        />
      ) : null}
    </>
  )
}

/** The vault's devices, this one marked; any other can be removed after a confirmation. */
export function DevicesRow(props: { onAnnounce: (text: string) => void; failed: Failure }) {
  const [devices, setDevices] = useState<SyncDevice[]>()
  const [problem, setProblem] = useState<string>()
  const [removing, setRemoving] = useState<SyncDevice>()
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [removed, setRemoved] = useState(0)
  const focusNext = useRef<string>(undefined)
  const list = useRef<HTMLUListElement>(null)
  const removeButtons = useRef(new Map<string, HTMLButtonElement>())
  const locale = currentLocale()
  const { onAnnounce, failed } = props

  useEffect(() => {
    let current = true
    listDevices().then(
      (found) => {
        if (!current) return
        setProblem(undefined)
        setDevices(found)
      },
      (e: unknown) => {
        if (current) setProblem(format(t('syncSettings.devicesFailed'), { code: errorCode(e) }))
      },
    )
    return () => {
      current = false
    }
  }, [])

  // Focus goes to the next device's Remove button, or the list when none is left after it.
  useEffect(() => {
    if (removed === 0) return
    const next = focusNext.current ? removeButtons.current.get(focusNext.current) : undefined
    ;(next ?? list.current)?.focus()
  }, [removed])

  const settle = (id: string) =>
    setPending((ids) => {
      const left = new Set(ids)
      left.delete(id)
      return left
    })

  const remove = (device: SyncDevice) => {
    setRemoving(undefined)
    if (pending.has(device.id)) return
    setPending((ids) => new Set(ids).add(device.id))
    removeDevice(device.id)
      .then((left) => {
        const index = devices?.findIndex((d) => d.id === device.id) ?? -1
        const next = devices
          ?.slice(index + 1)
          .find((d) => !d.current && left.some((l) => l.id === d.id))
        focusNext.current = next?.id
        setDevices(left)
        setRemoved((n) => n + 1)
        onAnnounce(t('syncSettings.deviceRemoved'))
      }, failed('syncSettings.removeFailed'))
      .finally(() => settle(device.id))
  }

  return (
    <>
      <Setting label="syncSettings.devices" description={problem ?? t('syncSettings.devicesHint')}>
        {null}
      </Setting>
      {devices && devices.length > 0 ? (
        <ul
          ref={list}
          tabIndex={-1}
          className="sync-devices"
          aria-label={t('syncSettings.devicesList')}
        >
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
                    ref={(button) => {
                      if (button) removeButtons.current.set(device.id, button)
                      else removeButtons.current.delete(device.id)
                    }}
                    type="button"
                    className="button"
                    aria-label={format(t('syncSettings.deviceRemoveLabel'), {
                      name: device.label,
                      date: day(device.created, locale),
                    })}
                    // Not disabled: focus stays on it while the relay answers.
                    aria-disabled={pending.has(device.id)}
                    onClick={() => {
                      if (!pending.has(device.id)) setRemoving(device)
                    }}
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
