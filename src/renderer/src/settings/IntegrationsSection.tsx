import { useEffect, useId, useRef, useState } from 'react'
import { CHOOSE_AI_ACCESS } from '../aiAccess'
import { errorCode } from '../backups'
import { writeClipboardText } from '../clipboard'
import { formatNumber } from '../format'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { Setting, SettingsSection } from './controls'
import { HttpApiSection } from './HttpApiSection'
import { claudeCodeCommand, codexConfig, mcpServersJson, type McpSetup } from './mcpConfigs'
import { aiAccessSummary, mcpSetup, showMainWindow, type AiAccessSummary } from './window'

const CLIENTS: readonly {
  id: string
  title: MessageKey
  where: MessageKey
  text: (setup: McpSetup) => string
}[] = [
  {
    id: 'claude-code',
    title: 'integrations.claudeCode',
    where: 'integrations.claudeCodeHint',
    text: claudeCodeCommand,
  },
  {
    id: 'codex',
    title: 'integrations.codex',
    where: 'integrations.codexHint',
    text: codexConfig,
  },
  {
    id: 'json',
    title: 'integrations.json',
    where: 'integrations.jsonHint',
    text: mcpServersJson,
  },
]

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

export function IntegrationsSection() {
  const ids = useId()
  // Undefined until Rust answers; the configs show only then.
  const [setup, setSetup] = useState<McpSetup>()
  const [setupError, setSetupError] = useState<string>()
  const [copyError, setCopyError] = useState<string>()
  const [announcement, setAnnouncement] = useState('')
  const [summary, setSummary] = useState<AiAccessSummary>()
  const [prompt, setPrompt] = useState(false)
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
    mcpSetup().then(
      (found) => {
        if (live) setSetup(found)
      },
      (e: unknown) => {
        if (!live) return
        // The configs still help, with a path to replace.
        setSetupError(errorCode(e))
        setSetup({ script: null, db: null })
      },
    )
    return () => {
      live = false
    }
  }, [])

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

  const errors = [
    setupError && format(t('integrations.setupFailed'), { code: setupError }),
    copyError && format(t('integrations.copyFailed'), { code: copyError }),
  ].filter(Boolean)

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
              label="integrations.scriptLabel"
              description={t(
                setup.script === null ? 'integrations.noScript' : 'integrations.script',
              )}
            >
              {null}
            </Setting>
          ) : null}
        </SettingsSection>
      ) : null}
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
        return (
          <SettingsSection key={client.id} title={client.title}>
            <p id={hint}>{t(client.where)}</p>
            <pre className="integration-config">
              <code>{text}</code>
            </pre>
            <div className="settings-buttons">
              <button
                type="button"
                className="button"
                aria-label={format(t('integrations.copyLabel'), { client: t(client.title) })}
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
      {prompt && summary ? (
        <AiAccessPrompt notebooks={summary.notebooks} onClose={() => setPrompt(false)} />
      ) : null}
    </section>
  )
}
