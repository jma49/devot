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
  const [originDraft, setOriginDraft] = useState('')
  const [originPending, setOriginPending] = useState<string[] | null>(null)
  const pair = useQueuedChoices<Pick<HttpApiView, 'enabled' | 'port' | 'extensionOrigins'>>(
    async (sent) => {
      try {
        const next = await saveHttpApi(sent.enabled, sent.port, sent.extensionOrigins)
        setView(next)
        setFailure(undefined)
        return next
      } finally {
        setOriginPending((current) =>
          current &&
          current.length === sent.extensionOrigins.length &&
          current.every((origin, i) => origin === sent.extensionOrigins[i])
            ? null
            : current,
        )
      }
    },
    (e: unknown) => {
      setAnnouncement('')
      setFailure({
        message:
          errorCode(e) === 'E_HTTP_API_ORIGINS_INVALID'
            ? 'httpApi.originsInvalid'
            : 'httpApi.saveFailed',
        code: logFailure(errorCode(e), 'W_HTTP_API_SETTINGS_FAILED'),
      })
    },
  )

  useEffect(() => {
    let live = true
    const take = pair.reading()
    loadHttpApi().then(
      (loaded) => {
        if (!live || !take(loaded)) return
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
  const changeOrigins = (extensionOrigins: string[]) => {
    setOriginPending(extensionOrigins)
    change({ extensionOrigins })
  }
  const origins = originPending ?? view?.extensionOrigins ?? []

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
          <Setting label="httpApi.extensions" description={t('httpApi.extensionsHint')} stacked>
            <ul className="http-api-origins" aria-label={t('httpApi.extensions')}>
              {origins.map((origin) => (
                <li key={origin}>
                  <code>{origin}</code>
                  <button
                    type="button"
                    className="button"
                    disabled={originPending !== null}
                    aria-label={format(t('httpApi.removeOrigin'), { origin })}
                    onClick={() => changeOrigins(origins.filter((item) => item !== origin))}
                  >
                    {t('httpApi.removeExtension')}
                  </button>
                </li>
              ))}
            </ul>
            {origins.length === 0 ? (
              <p className="settings-note">{t('httpApi.noExtensions')}</p>
            ) : null}
            <form
              className="http-api-origin-form"
              onSubmit={(event) => {
                event.preventDefault()
                const origin = originDraft.trim()
                if (
                  !origin ||
                  origins.includes(origin) ||
                  origins.length >= 8 ||
                  originPending !== null
                )
                  return
                changeOrigins([...origins, origin])
                setOriginDraft('')
              }}
            >
              <input
                type="text"
                className="settings-number settings-text"
                value={originDraft}
                spellCheck={false}
                autoComplete="off"
                aria-label={t('httpApi.extensionOrigin')}
                onChange={(event) => setOriginDraft(event.currentTarget.value)}
              />
              <button
                type="submit"
                className="button"
                disabled={
                  !originDraft.trim() ||
                  origins.includes(originDraft.trim()) ||
                  origins.length >= 8 ||
                  originPending !== null
                }
              >
                {t('httpApi.addExtension')}
              </button>
            </form>
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
