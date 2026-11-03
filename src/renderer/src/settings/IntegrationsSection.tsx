import { useEffect, useId, useRef, useState } from 'react'
import { CHOOSE_AI_ACCESS } from '../aiAccess'
import { errorCode } from '../backups'
import { Chevron } from '../Chevron'
import { writeClipboardText } from '../clipboard'
import { format, t, type MessageKey } from '../i18n'
import { SettingsSection } from './controls'
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

/** The primary change a row offers in each state; none for a file Devot leaves alone. */
const CONNECT_LABEL: Readonly<Record<McpConnectionState, MessageKey | null>> = {
  notConnected: 'integrations.connect',
  connected: null,
  stale: 'integrations.reconnect',
  other: 'integrations.replace',
  unreadable: null,
}

/** Opens the AI access picker in the main window: the flag in the storage both windows share asks it to. */
function openNotebookPicker() {
  try {
    localStorage.setItem(CHOOSE_AI_ACCESS, '1')
  } catch {
    // Without the shared storage the main window still opens; the picker is one menu away.
  }
  void showMainWindow().catch((e: unknown) =>
    console.warn('W_MAIN_WINDOW_SHOW_FAILED', errorCode(e)),
  )
}

/** Every configuration to copy, folded away under one disclosure at the end of the Clients card. */
function HandSetup(props: { setup: McpSetup; copy: (title: MessageKey, text: string) => void }) {
  const ids = useId()
  const [open, setOpen] = useState(false)
  return (
    <div className="setting setting-stacked hand-setup">
      <button
        type="button"
        className="hand-setup-toggle"
        aria-expanded={open}
        aria-controls={`${ids}-configs`}
        onClick={() => setOpen((shown) => !shown)}
      >
        <Chevron open={open} closed="right" />
        <span>{t('integrations.byHand')}</span>
      </button>
      {open ? (
        <div id={`${ids}-configs`} className="hand-setup-configs">
          {CLIENTS.map((client) => {
            const text = client.text(props.setup)
            const hint = `${ids}-${client.id}-hint`
            return (
              <div key={client.id} className="hand-setup-config">
                <span className="setting-label">{t(client.title)}</span>
                <span id={hint} className="setting-description">
                  {t(client.where)}
                </span>
                <pre className="integration-config">
                  <code>{text}</code>
                </pre>
                <div className="settings-buttons">
                  <button
                    type="button"
                    className="button"
                    aria-label={format(t('integrations.copyLabel'), { client: t(client.title) })}
                    aria-describedby={hint}
                    onClick={() => props.copy(client.title, text)}
                  >
                    {t('integrations.copy')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
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
    openNotebookPicker()
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
  const cli = status.via === 'claudeCli'
  const detail = cli
    ? connecting
      ? 'integrations.confirmCliConnectDetail'
      : 'integrations.confirmCliDisconnectDetail'
    : !connecting
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
      {cli ? null : (
        <p className="confirm-detail">{format(t('integrations.confirmRunning'), { client })}</p>
      )}
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

  const row = (client: (typeof CLIENTS)[number]) => {
    const status = setup?.clients.find((found) => found.client === client.connects)
    if (!status) return null
    const name = t(client.title)
    const primary = CONNECT_LABEL[status.state]
    const connected = status.state !== 'notConnected' && status.state !== 'unreadable'
    const label = (action: MessageKey) =>
      format(t('integrations.changeLabel'), { action: t(action), client: name })
    return (
      <div key={client.id} className="setting client-row" role="group" aria-label={name}>
        <div className="setting-text">
          <span className="setting-label">{name}</span>
          <span className="setting-description client-state">
            <span className="client-state-dot" data-state={status.state} aria-hidden="true" />
            {format(t(STATE_TEXT[status.state]), { code: status.code ?? '' })}
          </span>
        </div>
        <div className="setting-control">
          <div className="settings-buttons">
            {primary ? (
              <button
                type="button"
                className={status.state === 'notConnected' ? 'button button-default' : 'button'}
                disabled={!canWrite || busy || status.preview === null}
                aria-label={label(primary)}
                onClick={() => setPending({ action: 'connect', title: client.title, status })}
              >
                {t(primary)}
              </button>
            ) : null}
            {client.connects === 'claudeDesktop' && status.state === 'notConnected' ? (
              <button
                type="button"
                className="button"
                disabled={!canWrite || busy}
                onClick={openExtension}
              >
                {t('integrations.installExtension')}
              </button>
            ) : null}
            {connected ? (
              <button
                type="button"
                className="button"
                disabled={busy}
                aria-label={label('integrations.disconnect')}
                onClick={() => setPending({ action: 'disconnect', title: client.title, status })}
              >
                {t('integrations.disconnect')}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  return (
    <section className="settings-section" aria-labelledby="integrations-title">
      <h2 id="integrations-title" className="visually-hidden">
        {t('integrations.title')}
      </h2>
      <p>{t('integrations.detail')}</p>
      {errors.map((text) => (
        <p key={text} role="alert" className="settings-error">
          {text}
        </p>
      ))}
      <McpAccessSection
        changed={accessChanged}
        onChange={setAccess}
        summary={summary}
        onChooseNotebooks={openNotebookPicker}
      />
      {setup ? (
        <SettingsSection
          title="integrations.clientsTitle"
          footnote={setup.temporary ? t('integrations.temporary') : undefined}
        >
          {CLIENTS.map(row)}
          <HandSetup setup={setup} copy={copy} />
        </SettingsSection>
      ) : null}
      <HttpApiSection />
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
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
