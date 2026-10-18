import { useEffect, useId, useState } from 'react'
import { errorCode } from '../backups'
import { writeClipboardText } from '../clipboard'
import type { IconName } from '../icons/symbols'
import { format, t, type MessageKey } from '../i18n'
import { SettingsSection } from './controls'
import { claudeCodeCommand, codexConfig, mcpServersJson, type McpSetup } from './mcpConfigs'
import { mcpSetup } from './window'

/** Each client: its block's title, symbol, where the text goes, and the text. */
const CLIENTS: readonly {
  id: string
  title: MessageKey
  icon: IconName
  where: MessageKey
  text: (setup: McpSetup) => string
}[] = [
  {
    id: 'claude-code',
    title: 'integrations.claudeCode',
    icon: 'settings.terminal',
    where: 'integrations.claudeCodeHint',
    text: claudeCodeCommand,
  },
  {
    id: 'codex',
    title: 'integrations.codex',
    icon: 'settings.configFile',
    where: 'integrations.codexHint',
    text: codexConfig,
  },
  {
    id: 'json',
    title: 'integrations.json',
    icon: 'settings.json',
    where: 'integrations.jsonHint',
    text: mcpServersJson,
  },
]

/**
 * Settings > Integrations: devot-mcp's configs for Claude Code (a `claude mcp
 * add` command), Codex (`~/.codex/config.toml`) and any client with an
 * `mcpServers` JSON file, each with a Copy button. They run devot-mcp with
 * Node from the Devot checkout this app was built from when Rust finds it
 * there (`settings_mcp_setup`), or show a path to replace; a debug build's
 * configs name its own database.
 */
export function IntegrationsSection() {
  const ids = useId()
  // Undefined until Rust answers; the configs show only then.
  const [setup, setSetup] = useState<McpSetup>()
  const [setupError, setSetupError] = useState<string>()
  const [copyError, setCopyError] = useState<string>()
  const [announcement, setAnnouncement] = useState('')

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
      {setup ? (
        <p>{t(setup.script === null ? 'integrations.noScript' : 'integrations.script')}</p>
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
          <SettingsSection key={client.id} icon={client.icon} title={client.title}>
            <p id={hint} className="settings-note">
              {t(client.where)}
            </p>
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
    </section>
  )
}
