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
import { syncThroughICloud } from '../syncICloud'
import { Icon } from '../icons/Icon'
import { WithFigures } from '../phone/PhoneControls'
import { Setting } from './controls'
import { useOnPhone } from './onPhone'
import { failureText, logFailure } from './syncWhy'

// Settings > Sync's pairing, joining and devices (docs/adr/0008-sync-device-pairing.md). Rust holds
// every key; the page shows a pairing code while it is on show and the recovery key until saved.

export type Failure = (message: MessageKey) => (e: unknown) => void

const POLL_MS = 2_000
// Zone `devot`'s push says when the other device answers; polling iCloud is only the fallback.
const ICLOUD_POLL_MS = 10_000
const PAIRING_EVENT = 'devot://sync-pairing'
const QUIET_MODULES = 4

const day = (at: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(at)

function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function QrCode({ qr }: { qr: ShownPairing['qr'] }) {
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
  /** The vault syncs through iCloud, so the key alone restores it. */
  icloud?: boolean
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
    <Setting
      label="syncSettings.recovery"
      description={t(
        props.icloud ? 'syncSettings.recoveryHintIcloud' : 'syncSettings.recoveryHint',
      )}
      stacked
    >
      <div role="group" aria-label={t('syncSettings.recovery')} className="recovery-key">
        <pre ref={key} tabIndex={-1} className="integration-config">
          <code>{props.recoveryKey}</code>
        </pre>
      </div>
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
  /** The code goes through iCloud: the fallback for a device the iCloud Keychain did not reach. */
  icloud?: boolean
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
  const block = useRef<HTMLDivElement>(null)
  const showButton = useRef<HTMLButtonElement>(null)
  const code = useRef<HTMLParagraphElement>(null)
  const { onDevicesChanged, onAnnounce, failed, focusRequest } = props
  const icloud = props.icloud === true
  const pollMs = icloud ? ICLOUD_POLL_MS : POLL_MS
  const onPhone = useOnPhone()

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
      // Focus elsewhere (a field being typed in, an open dialog) stays where it is.
      const active = document.activeElement
      if (!active || active === document.body || block.current?.contains(active)) {
        setClosed((n) => n + 1)
      }
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
            timer = setTimeout(check, pollMs)
          }
        },
        (e: unknown) => {
          if (stopped) return
          if (TRANSIENT.has(errorCode(e))) {
            setUnreachable(true)
            timer = setTimeout(check, pollMs)
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
    timer = setTimeout(check, pollMs)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    let unlisten: (() => void) | undefined
    if (icloud && !DEVOT_UI_TEST) {
      void import('@tauri-apps/api/event')
        .then(({ listen }) =>
          listen(PAIRING_EVENT, () => {
            if (stopped) return
            clearTimeout(timer)
            check()
          }),
        )
        .then(
          (stop) => {
            if (stopped) stop()
            else unlisten = stop
          },
          () => console.warn('W_SYNC_LISTEN_FAILED'),
        )
    }
    return () => {
      stopped = true
      clearTimeout(timer)
      clearInterval(tick)
      unlisten?.()
    }
  }, [shown, onDevicesChanged, onAnnounce, failed, icloud, pollMs])

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

  // The link names the relay as well as the code, so a device that has not set the relay can join with it.
  const copyLink = () => {
    if (!shown) return
    void writeClipboardSecret(shown.link).then(
      () => onAnnounce(t('syncSettings.pairLinkCopied')),
      failed('syncSettings.pairCopyFailed'),
    )
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
    <Setting
      label="syncSettings.pair"
      description={
        ended ? t(ended) : t(icloud ? 'syncSettings.pairHintIcloud' : 'syncSettings.pairHint')
      }
    >
      {shown ? (
        <div
          ref={block}
          className="pairing"
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancel()
          }}
        >
          <QrCode qr={shown.qr} />
          <div className="pairing-text" role="group" aria-label={t('syncSettings.pairCode')}>
            <p ref={code} tabIndex={-1} className="pairing-code">
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
            {onPhone ? null : (
              <button type="button" className="button" onClick={copyLink}>
                {t('syncSettings.pairCopyLink')}
              </button>
            )}
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
            {onPhone ? <Icon name="phone.pair" size="md" /> : null}
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
  /** Into the Apple ID's vault: a bare code goes through iCloud, the key restores from it. */
  via?: 'icloud'
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
    if (props.via === 'icloud')
      return send(() =>
        how === 'recovery' ? syncThroughICloud(text) : joinWithCode(text, 'icloud'),
      )
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
      {row(
        'code',
        'syncSettings.joinCode',
        props.via ? 'syncSettings.joinCodeIcloudHint' : 'syncSettings.joinCodeHint',
        code,
        setCode,
      )}
      {row(
        'recovery',
        'syncSettings.joinRecovery',
        props.via ? 'syncSettings.joinRecoveryIcloudHint' : 'syncSettings.joinRecoveryHint',
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

/**
 * The vault's devices, this one marked; on a relay any other can be removed after a confirmation.
 * On iCloud a device leaves with its Apple ID, so the list only shows the day each was last seen,
 * then the relay devices not seen there since this device moved the vault.
 */
export function DevicesRow(props: {
  icloud?: boolean
  /** Reads the list again when it grows, without dropping a dialog or a removal in flight. */
  refresh: number
  onAnnounce: (text: string) => void
  failed: Failure
}) {
  const [devices, setDevices] = useState<SyncDevice[]>()
  const [problem, setProblem] = useState<string>()
  const [removing, setRemoving] = useState<SyncDevice>()
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [removed, setRemoved] = useState(0)
  const [retried, setRetried] = useState(0)
  const [recovered, setRecovered] = useState(0)
  const retryFocused = useRef(false)
  const removals = useRef(0)
  const focusNext = useRef<string>(undefined)
  const list = useRef<HTMLUListElement>(null)
  const removeButtons = useRef(new Map<string, HTMLButtonElement>())
  const locale = currentLocale()
  const { onAnnounce, failed, refresh } = props
  const icloud = props.icloud === true
  const datedAs = (device: SyncDevice): MessageKey =>
    device.unseen
      ? 'syncSettings.deviceUnseen'
      : icloud
        ? 'syncSettings.deviceSeen'
        : 'syncSettings.deviceAdded'
  const onPhone = useOnPhone()

  useEffect(() => {
    let current = true
    const started = removals.current
    listDevices().then(
      (found) => {
        // A removal answered meanwhile is newer than this list.
        if (!current || removals.current !== started) return
        setProblem(undefined)
        setDevices(found)
        if (retryFocused.current) setRecovered((n) => n + 1)
        retryFocused.current = false
      },
      (e: unknown) => {
        if (!current) return
        const text = failureText('syncSettings.devicesFailed', logFailure(errorCode(e)))
        setProblem(text)
        if (retryFocused.current) onAnnounce(text)
        retryFocused.current = false
      },
    )
    return () => {
      current = false
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A refresh or a Try Again lists the devices again.
  }, [refresh, retried, onAnnounce])

  // The Try Again button that had focus is gone: the list takes it.
  useEffect(() => {
    if (recovered > 0) list.current?.focus()
  }, [recovered])

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
        removals.current += 1
        setProblem(undefined)
        setDevices(left)
        setRemoved((n) => n + 1)
        onAnnounce(t('syncSettings.deviceRemoved'))
      }, failed('syncSettings.removeFailed'))
      .finally(() => settle(device.id))
  }

  return (
    <>
      <Setting
        label="syncSettings.devices"
        description={
          problem ??
          t(
            icloud
              ? devices?.some((d) => d.unseen)
                ? 'syncSettings.icloudDevicesUnseenHint'
                : 'syncSettings.icloudDevicesHint'
              : onPhone
                ? 'phone.sync.devicesHint'
                : 'syncSettings.devicesHint',
          )
        }
      >
        {problem ? (
          <div className="settings-buttons">
            <button
              type="button"
              className="button"
              onClick={(e) => {
                retryFocused.current = document.activeElement === e.currentTarget
                setRetried((n) => n + 1)
              }}
            >
              {t('syncSettings.devicesRetry')}
            </button>
          </div>
        ) : null}
      </Setting>
      {devices && devices.length > 0 ? (
        <ul
          ref={list}
          tabIndex={-1}
          className="sync-devices"
          aria-label={t('syncSettings.devicesList')}
        >
          {devices.map((device) => {
            const dated = datedAs(device)
            const added = format(t(dated), {
              date: day(device.created, locale),
            })
            return (
              <li key={device.id} className="sync-device">
                <div className="setting-text">
                  <span className="setting-label">{device.label}</span>
                  <span className="setting-description">
                    {onPhone ? (
                      <WithFigures
                        template={t(dated)}
                        values={{ date: day(device.created, locale) }}
                      />
                    ) : device.current ? (
                      `${added} · ${t('syncSettings.thisDevice')}`
                    ) : (
                      added
                    )}
                  </span>
                </div>
                {onPhone && device.current ? (
                  <span className="phone-device-badge">{t('phone.sync.you')}</span>
                ) : null}
                {device.current || icloud ? null : (
                  <button
                    ref={(button) => {
                      if (button) removeButtons.current.set(device.id, button)
                      else removeButtons.current.delete(device.id)
                    }}
                    type="button"
                    className="button"
                    data-destructive
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
          message={format(t('syncSettings.deviceRemoveConfirm'), {
            name: removing.label,
            date: day(removing.created, locale),
          })}
          detail={t('syncSettings.deviceRemoveDetail')}
          confirm={t('syncSettings.deviceRemoveButton')}
          onConfirm={() => remove(removing)}
          onCancel={() => setRemoving(undefined)}
        />
      ) : null}
    </>
  )
}
