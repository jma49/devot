import { useEffect, useId, useRef, useState } from 'react'
import { errorCode } from '../backups'
import { format, t, type MessageKey } from '../i18n'
import { Select, Setting, SettingsSection, SettingToggle } from './controls'
import type { McpAccess, McpScope, RunMode } from './mcpConfigs'
import { loadMcpAccess, loadRunMode, quitDevot, saveMcpAccess } from './window'

const SCOPES: readonly { id: McpScope; label: MessageKey }[] = [
  { id: 'readWrite', label: 'mcpAccess.readWrite' },
  { id: 'read', label: 'mcpAccess.read' },
]

type Choices = Pick<McpAccess, 'enabled' | 'scope' | 'backgroundStart'>

/**
 * Settings > Integrations > AI Tools: whether the bridge may reach Devot and start it, and how Devot
 * runs now, with a way to quit it (ADR 0012). `changed` counts changes made elsewhere (a Connect).
 */
export function McpAccessSection(props: { changed: number; onChange: (next: McpAccess) => void }) {
  const ids = useId()
  const { changed, onChange } = props
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

  return (
    <SettingsSection title="mcpAccess.title">
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
          {access.enabled && access.problem !== null ? (
            <p role="alert" className="settings-error">
              {format(t('mcpAccess.notReachable'), { code: access.problem })}
            </p>
          ) : null}
          <Setting
            label="mcpAccess.scope"
            description={t('mcpAccess.scopeHint')}
            htmlFor={`${ids}-scope`}
          >
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
        label="mcpAccess.running"
        description={
          mode === undefined
            ? ''
            : t(mode === 'background' ? 'mcpAccess.runningBackground' : 'mcpAccess.runningNormal')
        }
      >
        <button type="button" className="button" onClick={quit}>
          {t('mcpAccess.quit')}
        </button>
      </Setting>
    </SettingsSection>
  )
}
