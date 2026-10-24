import { useEffect, useId, useState } from 'react'
import { errorCode } from '../backups'
import { writeClipboardText } from '../clipboard'
import { format, t, type MessageKey } from '../i18n'
import { Setting, SettingToggle, SettingsSection } from './controls'
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
import { useTypedNumber } from './typedNumber'

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

  useEffect(() => {
    let live = true
    loadHttpApi().then(
      (loaded) => {
        if (live) setView(loaded)
      },
      (e: unknown) => {
        if (live) setFailure({ message: 'httpApi.loadFailed', code: errorCode(e) })
      },
    )
    return () => {
      live = false
    }
  }, [])

  const settle = (change: Promise<HttpApiView>, failed: MessageKey, done?: MessageKey) =>
    change.then(
      (next) => {
        setView(next)
        setFailure(undefined)
        if (done) setAnnouncement(t(done))
      },
      (e: unknown) => {
        setAnnouncement('')
        setFailure({ message: failed, code: errorCode(e) })
      },
    )

  const port = useTypedNumber({
    stored: view?.port ?? HTTP_API_MIN_PORT,
    min: HTTP_API_MIN_PORT,
    max: HTTP_API_MAX_PORT,
    store: (next) => {
      if (view) void settle(saveHttpApi(view.enabled, next), 'httpApi.saveFailed')
    },
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
        setFailure({ message: 'httpApi.tokenFailed', code: errorCode(e) })
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
      (e: unknown) => setFailure({ message: 'httpApi.copyFailed', code: errorCode(e) }),
    )
  }

  const status = !view
    ? ''
    : !view.enabled
      ? t('httpApi.portHint')
      : view.listening !== null
        ? format(t('httpApi.listening'), { port: String(view.listening) })
        : format(t('httpApi.notListening'), { code: view.problem ?? 'E_HTTP_API_FAILED' })
  const noKeychain = view?.token === 'unavailable'
  const hasToken = view?.token === 'set' || view?.token === 'unknown'

  return (
    <SettingsSection icon="settings.integrations" title="httpApi.title">
      <p className="settings-note">{t('httpApi.detail')}</p>
      {failure ? (
        <p role="alert" className="settings-error">
          {format(t(failure.message), { code: failure.code })}
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
            onChange={(on) => void settle(saveHttpApi(on, view.port), 'httpApi.saveFailed')}
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
              className="settings-number"
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
            <select
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
            </select>
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
