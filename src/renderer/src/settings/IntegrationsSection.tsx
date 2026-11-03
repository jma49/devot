import { useEffect, useId, useRef, useState } from 'react'
import { CHOOSE_AI_ACCESS } from '../aiAccess'
import { errorCode } from '../backups'
import { writeClipboardText } from '../clipboard'
import { formatNumber } from '../format'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { Setting, SettingsSection } from './controls'
import { HttpApiSection } from './HttpApiSection'
import { McpAccessSection } from './McpAccessSection'
import {
  claudeCodeCommand,
  codexConfig,
  mcpServersJson,
  NO_MCP_SETUP,
  type McpClient,
  type McpAccess as McpAccessView,
  type McpClientStatus,
  type McpConnectionState,
  type McpSetup,
} from './mcpConfigs'
import {
  aiAccessSummary,
  connectMcpClient,
  disconnectMcpClient,
  mcpSetup,
  openMcpExtension,
  showMainWindow,
  type AiAccessSummary,
} from './window'

const CLIENTS: readonly {
  id: string
  connects?: McpClient
  title: MessageKey
  where: MessageKey
  text: (setup: McpSetup) => string
}[] = [
  {
    id: 'claude-code',
    connects: 'claudeCode',
    title: 'integrations.claudeCode',
    where: 'integrations.claudeCodeHint',
    text: claudeCodeCommand,
  },
  {
    id: 'codex',
    connects: 'codex',
    title: 'integrations.codex',
    where: 'integrations.codexHint',
    text: codexConfig,
  },
  {
    id: 'claude-desktop',
    connects: 'claudeDesktop',
    title: 'integrations.claudeDesktop',
    where: 'integrations.claudeDesktopHint',
    text: mcpServersJson,
  },
  {
    id: 'json',
    title: 'integrations.json',
    where: 'integrations.jsonHint',
    text: mcpServersJson,
  },
]

const STATE_TEXT: Readonly<Record<McpConnectionState, MessageKey>> = {
  notConnected: 'integrations.stateNotConnected',
  connected: 'integrations.stateConnected',
  stale: 'integrations.stateStale',
  other: 'integrations.stateOther',
  unreadable: 'integrations.stateUnreadable',
}

const CONNECT_LABEL: Readonly<Record<McpConnectionState, MessageKey>> = {
  notConnected: 'integrations.connect',
  connected: 'integrations.reconnect',
  stale: 'integrations.reconnect',
  other: 'integrations.replace',
  unreadable: 'integrations.connect',
}

// Once per Settings window: "Later" keeps it quiet until the window closes.
let promptSeen = false

/**
 * Why MCP clients see nothing yet, and the way to the picker in the main
 * window: the flag in the storage both windows share asks it to open there.
 */
function AiAccessPrompt(props: { notebooks: number; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])
  const openPicker = () => {
    try {
      localStorage.setItem(CHOOSE_AI_ACCESS, '1')
    } catch {
      // Without the shared storage the main window still opens; the picker is one menu away.
    }
    void showMainWindow().catch((e: unknown) =>
      console.warn('W_MAIN_WINDOW_SHOW_FAILED', errorCode(e)),
    )
    props.onClose()
  }
  return (
    <dialog
      ref={dialog}
      className="confirm"
      aria-labelledby="ai-access-prompt-title"
      aria-describedby="ai-access-prompt-detail"
      onCancel={(e) => {
        e.preventDefault()
        props.onClose()
      }}
    >
      <p id="ai-access-prompt-title" className="confirm-message">
        {t('integrations.noAiAccessTitle')}
      </p>
      <p id="ai-access-prompt-detail" className="confirm-detail">
        {t(props.notebooks === 0 ? 'integrations.noNotebooks' : 'integrations.noAiAccess')}
      </p>
      <div className="confirm-actions">
        <button type="button" className="button" onClick={props.onClose} autoFocus>
          {t('integrations.later')}
        </button>
        <button type="button" className="button button-default" onClick={openPicker}>
          {t(props.notebooks === 0 ? 'integrations.openDevot' : 'integrations.chooseNotebooks')}
        </button>
      </div>
    </dialog>
  )
}

type Pending = { action: 'connect' | 'disconnect'; title: MessageKey; status: McpClientStatus }

const CAN_START_IN_BACKGROUND: McpAccessView = {
  enabled: false,
  scope: 'readWrite',
  backgroundStart: true,
  reachable: false,
  problem: null,
}

/** Shows the exact text and file before anything is written; nothing changes until confirmed. */
function ConfirmChange(props: {
  pending: Pending
  access: McpAccessView
  onCancel: () => void
  onConfirm: () => void
}) {
  const { action, title, status } = props.pending
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])
  const client = t(title)
  const connecting = action === 'connect'
  const message = connecting ? 'integrations.confirmConnect' : 'integrations.confirmDisconnect'
  const detail = !connecting
    ? 'integrations.confirmDisconnectDetail'
    : status.missing
      ? 'integrations.confirmCreateDetail'
      : 'integrations.confirmConnectDetail'
  return (
    <dialog
      ref={dialog}
      className="confirm integration-confirm"
      aria-labelledby="integration-confirm-title"
      aria-describedby="integration-confirm-detail"
      onCancel={(e) => {
        e.preventDefault()
        props.onCancel()
      }}
    >
      <p id="integration-confirm-title" className="confirm-message">
        {format(t(message), { client })}
      </p>
      <p id="integration-confirm-detail" className="confirm-detail">
        {format(t(detail), { path: status.path, backup: status.backup })}
      </p>
      {connecting && status.preview !== null ? (
        <pre className="integration-config">
          <code>{status.preview}</code>
        </pre>
      ) : null}
      <p className="confirm-detail">{format(t('integrations.confirmRunning'), { client })}</p>
      {connecting && !props.access.enabled ? (
        <p className="confirm-detail">{t('integrations.confirmAccessOn')}</p>
      ) : null}
      {connecting && props.access.backgroundStart ? (
        <p className="confirm-detail">{format(t('integrations.confirmBackground'), { client })}</p>
      ) : null}
      <div className="confirm-actions">
        <button type="button" className="button" onClick={props.onCancel} autoFocus>
          {t('integrations.cancel')}
        </button>
        <button type="button" className="button button-default" onClick={props.onConfirm}>
          {t(connecting ? 'integrations.connect' : 'integrations.disconnect')}
        </button>
      </div>
    </dialog>
  )
}

export function IntegrationsSection() {
  const ids = useId()
  // Undefined until Rust answers; the configs show only then.
  const [setup, setSetup] = useState<McpSetup>()
  const [setupError, setSetupError] = useState<string>()
  const [copyError, setCopyError] = useState<string>()
  const [changeError, setChangeError] = useState<string>()
  const [extensionError, setExtensionError] = useState<string>()
  const [announcement, setAnnouncement] = useState('')
  const [summary, setSummary] = useState<AiAccessSummary>()
  const [prompt, setPrompt] = useState(false)
  const [pending, setPending] = useState<Pending>()
  const [busy, setBusy] = useState(false)
  const [setupVersion, setSetupVersion] = useState(0)
  const [access, setAccess] = useState<McpAccessView>(CAN_START_IN_BACKGROUND)
  // Connecting turns access on in Rust: the section reads it again.
  const [accessChanged, setAccessChanged] = useState(0)
  useEffect(() => {
    let live = true
    const load = () => {
      aiAccessSummary().then(
        (found) => {
          if (!live) return
          setSummary(found)
          if (found.allowed === 0 && !promptSeen) {
            promptSeen = true
            setPrompt(true)
          }
        },
        (e: unknown) => {
          if (live) console.warn('W_AI_ACCESS_SUMMARY_FAILED', errorCode(e))
        },
      )
    }
    load()
    // Notebooks may be allowed while the pane is open (from the main window).
    window.addEventListener('focus', load)
    return () => {
      live = false
      window.removeEventListener('focus', load)
    }
  }, [])

  useEffect(() => {
    let live = true
    const load = () => {
      mcpSetup().then(
        (found) => {
          if (!live) return
          setSetup(found)
          setSetupError(undefined)
        },
        (e: unknown) => {
          if (!live) return
          // The configs still help, with the path an installed app has.
          setSetupError(errorCode(e))
          setSetup(NO_MCP_SETUP)
        },
      )
    }
    load()
    // A client's file may change while the pane is in the background.
    window.addEventListener('focus', load)
    return () => {
      live = false
      window.removeEventListener('focus', load)
    }
  }, [setupVersion])

  const copy = (title: MessageKey, text: string) => {
    setAnnouncement('')
    writeClipboardText(text).then(
      () => {
        setCopyError(undefined)
        setAnnouncement(format(t('integrations.copied'), { client: t(title) }))
      },
      (e: unknown) => setCopyError(errorCode(e)),
    )
  }

  const change = ({ action, title, status }: Pending) => {
    setPending(undefined)
    setBusy(true)
    setAnnouncement('')
    const run = action === 'connect' ? connectMcpClient : disconnectMcpClient
    run(status.client, status.revision)
      .then(
        (updated) => {
          setChangeError(undefined)
          setSetup(
            (known) =>
              known && {
                ...known,
                clients: known.clients.map((c) => (c.client === updated.client ? updated : c)),
              },
          )
          const done = action === 'connect' ? 'integrations.connected' : 'integrations.disconnected'
          setAnnouncement(format(t(done), { client: t(title) }))
          if (action === 'connect') {
            setAccessChanged((n) => n + 1)
            if (summary?.allowed === 0) setPrompt(true)
          }
        },
        (e: unknown) => {
          setChangeError(errorCode(e))
          // The file may have changed meanwhile: show it as it is now before another try.
          setSetupVersion((n) => n + 1)
        },
      )
      .finally(() => setBusy(false))
  }

  const openExtension = () => {
    setBusy(true)
    setAnnouncement('')
    openMcpExtension()
      .then(
        () => {
          setExtensionError(undefined)
          setAnnouncement(t('integrations.extensionOpened'))
          setAccessChanged((n) => n + 1)
          if (summary?.allowed === 0) setPrompt(true)
        },
        (e: unknown) => setExtensionError(errorCode(e)),
      )
      .finally(() => setBusy(false))
  }

  const errors = [
    setupError && format(t('integrations.setupFailed'), { code: setupError }),
    copyError && format(t('integrations.copyFailed'), { code: copyError }),
    changeError && format(t('integrations.changeFailed'), { code: changeError }),
    extensionError && format(t('integrations.extensionFailed'), { code: extensionError }),
  ].filter(Boolean)

  const canWrite = setup !== undefined && setup.command !== null && !setup.temporary

  return (
    <section className="settings-section" aria-labelledby="integrations-title">
      <h2 id="integrations-title" className="visually-hidden">
        {t('integrations.title')}
      </h2>
      <p>{t('integrations.detail')}</p>
      {summary || setup ? (
        <SettingsSection title="integrations.mcpTitle">
          {summary ? (
            <Setting
              label="integrations.accessLabel"
              description={format(t('integrations.aiAccessCount'), {
                allowed: formatNumber(summary.allowed, currentLocale()),
                notebooks: formatNumber(summary.notebooks, currentLocale()),
              })}
            >
              {null}
            </Setting>
          ) : null}
          {setup ? (
            <Setting
              label="integrations.setupLabel"
              description={t(setup.temporary ? 'integrations.temporary' : 'integrations.ready')}
            >
              {null}
            </Setting>
          ) : null}
        </SettingsSection>
      ) : null}
      <McpAccessSection changed={accessChanged} onChange={setAccess} />
      {errors.map((text) => (
        <p key={text} role="alert" className="settings-error">
          {text}
        </p>
      ))}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      {CLIENTS.map((client) => {
        if (!setup) return null
        const text = client.text(setup)
        const hint = `${ids}-${client.id}-hint`
        const status = setup.clients.find((found) => found.client === client.connects)
        const name = t(client.title)
        return (
          <SettingsSection key={client.id} title={client.title}>
            {status ? (
              <p>
                {format(t(STATE_TEXT[status.state]), {
                  client: name,
                  path: status.path,
                  code: status.code ?? '',
                })}
              </p>
            ) : null}
            <p id={hint}>{t(client.where)}</p>
            <pre className="integration-config">
              <code>{text}</code>
            </pre>
            <div className="settings-buttons">
              {status && status.state !== 'unreadable' ? (
                <button
                  type="button"
                  className="button"
                  disabled={!canWrite || busy || status.preview === null}
                  aria-label={format(t('integrations.changeLabel'), {
                    action: t(CONNECT_LABEL[status.state]),
                    client: name,
                  })}
                  onClick={() => setPending({ action: 'connect', title: client.title, status })}
                >
                  {t(CONNECT_LABEL[status.state])}
                </button>
              ) : null}
              {status &&
              (status.state === 'connected' ||
                status.state === 'stale' ||
                status.state === 'other') ? (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  aria-label={format(t('integrations.changeLabel'), {
                    action: t('integrations.disconnect'),
                    client: name,
                  })}
                  onClick={() => setPending({ action: 'disconnect', title: client.title, status })}
                >
                  {t('integrations.disconnect')}
                </button>
              ) : null}
              {client.connects === 'claudeDesktop' ? (
                <button
                  type="button"
                  className="button"
                  disabled={!canWrite || busy}
                  onClick={openExtension}
                >
                  {t('integrations.openExtension')}
                </button>
              ) : null}
              <button
                type="button"
                className="button"
                aria-label={format(t('integrations.copyLabel'), { client: name })}
                aria-describedby={hint}
                onClick={() => copy(client.title, text)}
              >
                {t('integrations.copy')}
              </button>
            </div>
          </SettingsSection>
        )
      })}
      <HttpApiSection />
      {pending ? (
        <ConfirmChange
          pending={pending}
          access={access}
          onCancel={() => setPending(undefined)}
          onConfirm={() => change(pending)}
        />
      ) : null}
      {prompt && summary ? (
        <AiAccessPrompt notebooks={summary.notebooks} onClose={() => setPrompt(false)} />
      ) : null}
    </section>
  )
}
