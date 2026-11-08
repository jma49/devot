import { useEffect, useId, useState } from 'react'
import { errorCode } from '../backups'
import { writeClipboardText } from '../clipboard'
import { format, t, type MessageKey } from '../i18n'
import { Select, Setting, SettingsSection, SettingToggle } from './controls'
import {
  curlExample,
  HTTP_API_MAX_PORT,
  HTTP_API_MIN_PORT,
  loadHttpApi,
  newHttpApiToken,
  revealHttpApiToken,
  saveHttpApi,
  type HttpApiScope,
  type HttpApiView,
} from './httpApi'
import { useQueuedChoices } from './queuedChoices'
import { useTypedNumber } from './typedNumber'
import { failureText, logFailure } from '../failure'

const SCOPES: readonly { id: HttpApiScope; label: MessageKey }[] = [
  { id: 'read', label: 'httpApi.read' },
  { id: 'readWrite', label: 'httpApi.readWrite' },
]

/** Settings > Integrations > Local HTTP API. */
export function HttpApiSection() {
  const ids = useId()
  const id = (name: string) => `${ids}-${name}`
  const [view, setView] = useState<HttpApiView>()
  const [shown, setShown] = useState<string>()
  const [failure, setFailure] = useState<{ message: MessageKey; code: string }>()
  const [announcement, setAnnouncement] = useState('')
  // The switch and the port each send the whole pair, so building it from a stale view (or letting
  // two saves race) would undo the other.
  const pair = useQueuedChoices<{ enabled: boolean; port: number }>(
    async (sent) => {
      const next = await saveHttpApi(sent.enabled, sent.port)
      setView(next)
      setFailure(undefined)
      return { enabled: next.enabled, port: next.port }
    },
    (e: unknown) => {
      setAnnouncement('')
      setFailure({
        message: 'httpApi.saveFailed',
        code: logFailure(errorCode(e), 'W_HTTP_API_SETTINGS_FAILED'),
      })
    },
  )

  useEffect(() => {
    let live = true
    const take = pair.reading()
    loadHttpApi().then(
      (loaded) => {
        if (!live || !take({ enabled: loaded.enabled, port: loaded.port })) return
        setView(loaded)
      },
      (e: unknown) => {
        if (live)
          setFailure({
            message: 'httpApi.loadFailed',
            code: logFailure(errorCode(e), 'W_HTTP_API_SETTINGS_FAILED'),
          })
      },
    )
    return () => {
      live = false
    }
  }, [pair])

  const settle = (change: Promise<HttpApiView>, failed: MessageKey, done?: MessageKey) =>
    change.then(
      (next) => {
        setView(next)
        setFailure(undefined)
        if (done) setAnnouncement(t(done))
        return next
      },
      (e: unknown) => {
        setAnnouncement('')
        setFailure({
          message: failed,
          code: logFailure(errorCode(e), 'W_HTTP_API_SETTINGS_FAILED'),
        })
        return undefined
      },
    )

  const change = pair.change

  const port = useTypedNumber({
    stored: view?.port ?? HTTP_API_MIN_PORT,
    min: HTTP_API_MIN_PORT,
    max: HTTP_API_MAX_PORT,
    store: (next) => change({ port: next }),
  })

  const rotate = (scope: HttpApiScope) => {
    setShown(undefined)
    void settle(newHttpApiToken(scope), 'httpApi.tokenFailed', 'httpApi.tokenMade')
  }

  const reveal = () =>
    revealHttpApiToken().then(
      (token) => {
        setFailure(undefined)
        return token
      },
      (e: unknown) => {
        setFailure({
          message: 'httpApi.tokenFailed',
          code: logFailure(errorCode(e), 'W_HTTP_API_SETTINGS_FAILED'),
        })
        return undefined
      },
    )

  const toggleShown = () => {
    if (shown !== undefined) setShown(undefined)
    else void reveal().then(setShown)
  }

  const copy = async () => {
    setAnnouncement('')
    const token = shown ?? (await reveal())
    if (token === undefined) return
    writeClipboardText(token).then(
      () => setAnnouncement(t('httpApi.tokenCopied')),
      (e: unknown) =>
        setFailure({
          message: 'httpApi.copyFailed',
          code: logFailure(errorCode(e), 'W_HTTP_API_SETTINGS_FAILED'),
        }),
    )
  }

  const status = !view
    ? ''
    : !view.enabled
      ? t('httpApi.portHint')
      : view.listening !== null
        ? format(t('httpApi.listening'), { port: String(view.listening) })
        : failureText('httpApi.notListening', view.problem ?? 'E_HTTP_API_FAILED')
  const noKeychain = view?.token === 'unavailable'
  const hasToken = view?.token === 'set' || view?.token === 'unknown'

  return (
    <SettingsSection title="httpApi.title">
      <p className="settings-note">{t('httpApi.detail')}</p>
      {failure ? (
        <p role="alert" className="settings-error">
          {failureText(failure.message, failure.code)}
        </p>
      ) : null}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      {view ? (
        <>
          <SettingToggle
            label="httpApi.enabled"
            description="httpApi.enabledHint"
            note={noKeychain ? 'httpApi.noKeychain' : undefined}
            checked={view.enabled}
            disabled={noKeychain}
            onChange={(on) => change({ enabled: on })}
          />
          <Setting
            label="httpApi.port"
            description={status}
            htmlFor={id('port')}
            descriptionId={id('port-hint')}
          >
            <input
              id={id('port')}
              type="number"
              className="settings-number settings-port"
              min={HTTP_API_MIN_PORT}
              max={HTTP_API_MAX_PORT}
              step={1}
              value={port.value}
              aria-describedby={id('port-hint')}
              onChange={(e) => port.type(e.currentTarget.value)}
              onBlur={port.leave}
            />
          </Setting>
          <Setting
            label="httpApi.access"
            description={t('httpApi.accessHint')}
            htmlFor={id('access')}
            descriptionId={id('access-hint')}
          >
            <Select
              id={id('access')}
              value={view.scope}
              disabled={noKeychain}
              aria-describedby={id('access-hint')}
              onChange={(e) => rotate(e.currentTarget.value as HttpApiScope)}
            >
              {SCOPES.map((scope) => (
                <option key={scope.id} value={scope.id}>
                  {t(scope.label)}
                </option>
              ))}
            </Select>
          </Setting>
          <Setting label="httpApi.token" description={t('httpApi.tokenHint')}>
            {shown !== undefined ? (
              <pre className="integration-config" aria-label={t('httpApi.token')}>
                <code>{shown}</code>
              </pre>
            ) : null}
            <div className="settings-buttons">
              <button type="button" className="button" disabled={!hasToken} onClick={toggleShown}>
                {t(shown === undefined ? 'httpApi.showToken' : 'httpApi.hideToken')}
              </button>
              <button
                type="button"
                className="button"
                disabled={!hasToken}
                onClick={() => void copy()}
              >
                {t('httpApi.copyToken')}
              </button>
              <button
                type="button"
                className="button"
                disabled={noKeychain}
                onClick={() => rotate(view.scope)}
              >
                {t('httpApi.newToken')}
              </button>
            </div>
          </Setting>
          <p className="settings-note">{t('httpApi.example')}</p>
          <pre className="integration-config">
            <code>{curlExample(view.port)}</code>
          </pre>
        </>
      ) : null}
    </SettingsSection>
  )
}
