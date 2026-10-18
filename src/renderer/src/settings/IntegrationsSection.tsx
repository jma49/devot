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
  const [setup, setSetup] = useState<McpSetup>({ script: null, db: null })
  const [known, setKnown] = useState(false)
  const [error, setError] = useState<{ message: MessageKey; code: string }>()
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    let live = true
    mcpSetup().then(
      (found) => {
        if (!live) return
        setSetup(found)
        setKnown(true)
      },
      (e: unknown) => {
        if (live) setError({ message: 'integrations.setupFailed', code: errorCode(e) })
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
        setError(undefined)
        setAnnouncement(format(t('integrations.copied'), { client: t(title) }))
      },
      (e: unknown) => setError({ message: 'integrations.copyFailed', code: errorCode(e) }),
    )
  }

  return (
    <section className="settings-section" aria-labelledby="integrations-title">
      <h2 id="integrations-title" className="visually-hidden">
        {t('integrations.title')}
      </h2>
      <p>{t('integrations.detail')}</p>
      {known ? (
        <p>{t(setup.script === null ? 'integrations.noScript' : 'integrations.script')}</p>
      ) : null}
      {error ? (
        <p role="alert" className="settings-error">
          {format(t(error.message), { code: error.code })}
        </p>
      ) : null}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      {CLIENTS.map((client) => {
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
