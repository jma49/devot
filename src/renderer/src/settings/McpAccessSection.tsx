import { useEffect, useId, useRef, useState } from 'react'
import { errorCode } from '../backups'
import { formatNumber } from '../format'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { Select, Setting, SettingsSection, SettingToggle } from './controls'
import type { McpAccess, McpScope, RunMode } from './mcpConfigs'
import {
  loadMcpAccess,
  loadRunMode,
  quitDevot,
  saveMcpAccess,
  type AiAccessSummary,
} from './window'

const SCOPES: readonly { id: McpScope; label: MessageKey }[] = [
  { id: 'readWrite', label: 'mcpAccess.readWrite' },
  { id: 'read', label: 'mcpAccess.read' },
]

/** macOS asks the owner first; nothing is wrong, and Devot goes on once it is allowed. */
const KEYCHAIN_WAITING = 'E_MCP_KEYCHAIN_WAITING'

type Choices = Pick<McpAccess, 'enabled' | 'scope' | 'backgroundStart'>

/**
 * Settings > Integrations > AI Tools: whether the bridge may reach Devot and start it, which
 * notebooks it sees, and how Devot runs now, with a way to quit it (ADR 0012). `changed` counts
 * changes made elsewhere (a Connect).
 */
export function McpAccessSection(props: {
  changed: number
  onChange: (next: McpAccess) => void
  summary: AiAccessSummary | undefined
  onChooseNotebooks: () => void
}) {
  const ids = useId()
  const { changed, onChange, summary } = props
  const [access, setAccess] = useState<McpAccess>()
  const [mode, setMode] = useState<RunMode>()
  const [failure, setFailure] = useState<{ message: MessageKey; code: string }>()
  const saving = useRef<Promise<void>>(Promise.resolve())
  const wanted = useRef<Choices | null>(null)

  useEffect(() => {
    let live = true
    const load = () => {
      loadMcpAccess().then(
        (loaded) => {
          if (!live) return
          setAccess(loaded)
          onChange(loaded)
          wanted.current = {
            enabled: loaded.enabled,
            scope: loaded.scope,
            backgroundStart: loaded.backgroundStart,
          }
        },
        (e: unknown) => {
          if (live) setFailure({ message: 'mcpAccess.loadFailed', code: errorCode(e) })
        },
      )
      loadRunMode().then(
        (loaded) => {
          if (live) setMode(loaded)
        },
        (e: unknown) => {
          if (live) setFailure({ message: 'mcpAccess.loadFailed', code: errorCode(e) })
        },
      )
    }
    load()
    // Devot may have been opened, or a tool started, while the pane was behind another window.
    window.addEventListener('focus', load)
    return () => {
      live = false
      window.removeEventListener('focus', load)
    }
  }, [changed, onChange])

  /** Saves one after another, each sending every choice as it stands then. */
  const change = (patch: Partial<Choices>) => {
    const current = wanted.current
    if (!current) return
    wanted.current = { ...current, ...patch }
    saving.current = saving.current.then(async () => {
      const sent = wanted.current
      if (!sent) return
      await saveMcpAccess(sent).then(
        (next) => {
          setAccess(next)
          onChange(next)
          setFailure(undefined)
        },
        (e: unknown) => setFailure({ message: 'mcpAccess.saveFailed', code: errorCode(e) }),
      )
    })
  }

  const quit = () => {
    quitDevot().catch((e: unknown) =>
      setFailure({ message: 'mcpAccess.quitFailed', code: errorCode(e) }),
    )
  }

  const notebooks = summary
    ? format(t('integrations.aiAccessCount'), {
        allowed: formatNumber(summary.allowed, currentLocale()),
        notebooks: formatNumber(summary.notebooks, currentLocale()),
      })
    : ''

  return (
    <SettingsSection title="mcpAccess.title" footnote={t('mcpAccess.footnote')}>
      {failure ? (
        <p role="alert" className="settings-error">
          {format(t(failure.message), { code: failure.code })}
        </p>
      ) : null}
      {access ? (
        <>
          <SettingToggle
            label="mcpAccess.enabled"
            description="mcpAccess.enabledHint"
            checked={access.enabled}
            onChange={(on) => change({ enabled: on })}
          />
          {access.enabled && access.problem === KEYCHAIN_WAITING ? (
            <p role="status" className="settings-note">
              {format(t('mcpAccess.keychainWaiting'), { code: access.problem })}
            </p>
          ) : access.enabled && access.problem !== null ? (
            <p role="alert" className="settings-error">
              {format(t('mcpAccess.notReachable'), { code: access.problem })}
            </p>
          ) : null}
          <Setting label="mcpAccess.notebooks" description={notebooks}>
            <button type="button" className="button" onClick={props.onChooseNotebooks}>
              {t('mcpAccess.chooseNotebooks')}
            </button>
          </Setting>
          <Setting label="mcpAccess.scope" description="" htmlFor={`${ids}-scope`}>
            <Select
              id={`${ids}-scope`}
              value={access.scope}
              onChange={(e) => change({ scope: e.currentTarget.value as McpScope })}
            >
              {SCOPES.map((scope) => (
                <option key={scope.id} value={scope.id}>
                  {t(scope.label)}
                </option>
              ))}
            </Select>
          </Setting>
          <SettingToggle
            label="mcpAccess.backgroundStart"
            description="mcpAccess.backgroundStartHint"
            checked={access.backgroundStart}
            onChange={(on) => change({ backgroundStart: on })}
          />
        </>
      ) : null}
      <Setting
        label="mcpAccess.status"
        description={
          mode === undefined
            ? ''
            : t(mode === 'background' ? 'mcpAccess.runningBackground' : 'mcpAccess.runningNormal')
        }
      >
        {mode === 'background' ? (
          <button type="button" className="button" onClick={quit}>
            {t('mcpAccess.quit')}
          </button>
        ) : null}
      </Setting>
    </SettingsSection>
  )
}
