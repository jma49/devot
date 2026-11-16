import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  fitsSetting,
  type InstalledPlugin,
  type PluginPermission,
  type PluginSetting,
  type SettingValue,
} from '../../../core/plugins'
import { errorCode } from '../backups'
import { ConfirmDialog } from '../ConfirmDialog'
import { format, t, type MessageKey } from '../i18n'
import { Select, Setting, SettingsSection } from './controls'
import {
  cancelInstall,
  fetchOfficialPlugin,
  installPlugin,
  listOfficialPlugins,
  listPlugins,
  pickPlugin,
  pluginSettings,
  removePlugin,
  setPluginSetting,
  setPluginEnabled,
  watchPlugins,
  type OfferedPlugin,
  type StagedPlugin,
} from '../plugins/api'
import { failureText, logFailure } from '../failure'

const PERMISSION_TEXT: Readonly<Record<PluginPermission, MessageKey>> = {
  'note.read': 'plugins.permission.note.read',
  'note.edit': 'plugins.permission.note.edit',
  commands: 'plugins.permission.commands',
  menus: 'plugins.permission.menus',
  keymaps: 'plugins.permission.keymaps',
  preview: 'plugins.permission.preview',
  import: 'plugins.permission.import',
  export: 'plugins.permission.export',
  storage: 'plugins.permission.storage',
  'notes.read': 'plugins.permission.notesRead',
}

function Permissions(props: { list: readonly PluginPermission[]; label: MessageKey }) {
  if (props.list.length === 0)
    return <p className="plugin-permissions-intro">{t('plugins.noPermissions')}</p>
  return (
    <>
      <p className="plugin-permissions-intro">{t(props.label)}</p>
      <ul className="plugin-permissions">
        {props.list.map((p) => (
          <li key={p} data-permission={p}>
            {t(PERMISSION_TEXT[p])}
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * The permissions a package asks for, shown before anything is installed: Install approves them all, Cancel (which has the
 * keyboard, so Return and Escape cancel) installs nothing.
 */
function Review(props: { staged: StagedPlugin; onInstall: () => void; onCancel: () => void }) {
  const { manifest, replaces } = props.staged
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="confirm plugin-review"
      aria-labelledby="plugin-review-title"
      aria-describedby="plugin-review-detail"
      onCancel={(e) => {
        e.preventDefault()
        props.onCancel()
      }}
    >
      <p id="plugin-review-title" className="confirm-message">
        {format(t('plugins.reviewTitle'), { name: manifest.name })}
      </p>
      <div id="plugin-review-detail" className="confirm-detail">
        <p>{format(t('plugins.reviewDetail'), { version: manifest.version })}</p>
        {replaces ? (
          <p>
            {format(t('plugins.reviewReplace'), {
              old: replaces.version,
              version: manifest.version,
            })}
          </p>
        ) : null}
        <Permissions list={manifest.permissions} label="plugins.reviewAsks" />
      </div>
      <div className="confirm-actions">
        <button type="button" className="button" onClick={props.onCancel} autoFocus>
          {t('dialog.cancel')}
        </button>
        <button type="button" className="button button-default" onClick={props.onInstall}>
          {t('plugins.install')}
        </button>
      </div>
    </dialog>
  )
}

function SettingControl(props: {
  setting: PluginSetting
  value: SettingValue
  labelId: string
  onChange: (value: SettingValue) => void
}) {
  const { setting, value, labelId, onChange } = props
  const [draft, setDraft] = useState(String(value))
  const commit = (raw: string) => {
    const next = setting.type === 'number' ? Number(raw) : raw
    if (raw.trim() !== '' && fitsSetting(setting, next)) {
      if (next !== value) onChange(next)
    } else setDraft(String(value))
  }
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit(e.currentTarget.value)
  }
  switch (setting.type) {
    case 'toggle':
      return (
        <input
          type="checkbox"
          role="switch"
          checked={value === true}
          aria-labelledby={labelId}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
      )
    case 'choice':
      return (
        <Select
          aria-labelledby={labelId}
          value={String(value)}
          onChange={(e) => onChange(e.currentTarget.value)}
        >
          {setting.choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </Select>
      )
    case 'text':
    case 'number':
      return (
        <input
          type={setting.type === 'number' ? 'number' : 'text'}
          className={
            setting.type === 'number' ? 'settings-number' : 'settings-number settings-text'
          }
          aria-labelledby={labelId}
          spellCheck={false}
          autoComplete="off"
          value={draft}
          min={setting.type === 'number' ? (setting.min ?? undefined) : undefined}
          max={setting.type === 'number' ? (setting.max ?? undefined) : undefined}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={onEnter}
        />
      )
  }
}

/** The settings a plugin declares, drawn by Devot; the plugin is told when one changes. */
function PluginSettings(props: { plugin: InstalledPlugin; onFailure: (code: string) => void }) {
  const { manifest } = props.plugin
  const { onFailure } = props
  const [values, setValues] = useState<Record<string, SettingValue>>()
  const id = useId()
  useEffect(() => {
    let live = true
    pluginSettings(manifest.id).then(
      (next) => {
        if (live) setValues(next)
      },
      (e: unknown) => onFailure(errorCode(e)),
    )
    return () => {
      live = false
    }
  }, [manifest, onFailure])
  if (!values) return null
  const change = (setting: string, value: SettingValue) => {
    const before = values[setting]
    setValues((now) => ({ ...now, [setting]: value }))
    setPluginSetting(manifest.id, setting, value).catch((e: unknown) => {
      setValues((now) => (now && before !== undefined ? { ...now, [setting]: before } : now))
      onFailure(errorCode(e))
    })
  }
  return (
    <li
      className="plugin-settings"
      aria-label={format(t('plugins.settingsLabel'), { name: manifest.name })}
    >
      {manifest.contributes.settings.map((setting) => {
        const value = values[setting.id] ?? setting.default
        const labelId = `${id}-${setting.id}`
        return (
          <div
            key={setting.id}
            className={setting.type === 'toggle' ? 'setting setting-toggle' : 'setting'}
          >
            <div className="setting-text">
              <span id={labelId} className="setting-label">
                {setting.title}
              </span>
              {setting.description ? (
                <span className="setting-description">{setting.description}</span>
              ) : null}
            </div>
            <div className="setting-control">
              <SettingControl
                key={String(value)}
                setting={setting}
                value={value}
                labelId={labelId}
                onChange={(next) => change(setting.id, next)}
              />
            </div>
          </div>
        )
      })}
    </li>
  )
}

type Catalog =
  | { phase: 'loading' }
  | { phase: 'failed'; code: string }
  | { phase: 'ready'; list: OfferedPlugin[] }

function OfferButton(props: { plugin: OfferedPlugin; busy: boolean; onFetch: () => void }) {
  const { plugin, busy, onFetch } = props
  switch (plugin.offer) {
    case 'install':
    case 'update':
      return (
        <button
          type="button"
          className="button"
          disabled={busy}
          aria-label={
            plugin.offer === 'install'
              ? format(t('plugins.catalogInstallLabel'), { name: plugin.name })
              : format(t('plugins.catalogUpdateLabel'), {
                  name: plugin.name,
                  version: plugin.version,
                })
          }
          onClick={onFetch}
        >
          {t(plugin.offer === 'install' ? 'plugins.catalogInstall' : 'plugins.catalogUpdate')}
        </button>
      )
    case 'installed':
      return <span className="setting-description">{t('plugins.catalogInstalled')}</span>
    case 'needsNewerApp':
      return <span className="setting-description">{t('plugins.catalogNeedsApp')}</span>
  }
}

/** The official plugin index (ADR 0025): a pick fetches the plugin and shows the same review as a package the user picks. */
function OfficialPlugins(props: {
  onStaged: (staged: StagedPlugin) => void
  onFailure: (code: string) => void
}) {
  const { onStaged, onFailure } = props
  const [catalog, setCatalog] = useState<Catalog>({ phase: 'loading' })
  const [fetching, setFetching] = useState<string>()
  const asked = useRef(0)
  const fetchAsked = useRef(0)

  const load = useCallback(() => {
    const request = ++asked.current
    listOfficialPlugins().then(
      (list) => {
        if (request === asked.current) setCatalog({ phase: 'ready', list })
      },
      (e: unknown) => {
        if (request === asked.current)
          setCatalog({ phase: 'failed', code: logFailure(errorCode(e), 'W_PLUGINS_FAILED') })
      },
    )
  }, [])

  useEffect(() => {
    load()
    return watchPlugins(load)
  }, [load])

  const fetchPlugin = (id: string) => {
    const request = ++fetchAsked.current
    setFetching(id)
    fetchOfficialPlugin(id).then(
      (staged) => {
        if (request !== fetchAsked.current) {
          void cancelInstall(staged.token).catch(() => console.warn('W_PLUGIN_CANCEL_FAILED'))
          return
        }
        setFetching(undefined)
        onStaged(staged)
      },
      (e: unknown) => {
        if (request !== fetchAsked.current) return
        setFetching(undefined)
        onFailure(errorCode(e))
      },
    )
  }

  useEffect(
    () => () => {
      fetchAsked.current++
    },
    [],
  )

  return (
    <SettingsSection title="plugins.catalogTitle">
      {catalog.phase === 'loading' ? (
        <p role="status">{t('plugins.catalogLoading')}</p>
      ) : catalog.phase === 'failed' ? (
        <div className="setting">
          <div className="setting-text">
            <span className="setting-description">
              {failureText('plugins.catalogFailed', catalog.code)}
            </span>
          </div>
          <div className="setting-control">
            <button
              type="button"
              className="button"
              onClick={() => {
                setCatalog({ phase: 'loading' })
                load()
              }}
            >
              {t('plugins.catalogRetry')}
            </button>
          </div>
        </div>
      ) : (
        <ul className="plugin-list" aria-label={t('plugins.catalogLabel')}>
          {catalog.list.map((p) => {
            const titleId = `official-plugin-${p.id}`
            return (
              <li key={p.id} className="setting plugin-row" aria-labelledby={titleId}>
                <div className="setting-text">
                  <span id={titleId} className="setting-label">
                    {p.name}
                  </span>
                  <span className="setting-description">
                    {p.author
                      ? format(t('plugins.versionBy'), { version: p.version, author: p.author })
                      : format(t('plugins.version'), { version: p.version })}
                  </span>
                  {p.description ? (
                    <span className="setting-description">{p.description}</span>
                  ) : null}
                </div>
                <div className="setting-control">
                  <OfferButton
                    plugin={p}
                    busy={fetching !== undefined}
                    onFetch={() => fetchPlugin(p.id)}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </SettingsSection>
  )
}

/** Settings > Plugins: installs from a folder or archive after the user approves its permissions, turns plugins on and off, removes them. */
export function PluginsSection() {
  const [plugins, setPlugins] = useState<InstalledPlugin[]>()
  const [staged, setStaged] = useState<StagedPlugin>()
  const [removing, setRemoving] = useState<InstalledPlugin>()
  const [failure, setFailure] = useState<{ message: MessageKey; code: string }>()

  const load = useCallback(
    () =>
      listPlugins().then(
        (list) => setPlugins(list),
        (e: unknown) =>
          setFailure({
            message: 'plugins.loadFailed',
            code: logFailure(errorCode(e), 'W_PLUGINS_FAILED'),
          }),
      ),
    [],
  )

  useEffect(() => {
    void load()
    return watchPlugins(() => void load())
  }, [load])

  const settingFailed = useCallback(
    (code: string) =>
      setFailure({
        message: 'plugins.settingFailed',
        code: logFailure(code, 'W_PLUGINS_FAILED'),
      }),
    [],
  )

  const settle = (change: Promise<unknown>, failed: MessageKey) =>
    change.then(
      () => {
        setFailure(undefined)
        return load()
      },
      (e: unknown) =>
        setFailure({ message: failed, code: logFailure(errorCode(e), 'W_PLUGINS_FAILED') }),
    )

  const pick = (kind: 'folder' | 'archive') =>
    pickPlugin(kind).then(
      (next) => {
        setFailure(undefined)
        if (next) setStaged(next)
      },
      (e: unknown) =>
        setFailure({
          message: 'plugins.installFailed',
          code: logFailure(errorCode(e), 'W_PLUGINS_FAILED'),
        }),
    )

  const catalogFailed = useCallback(
    (code: string) =>
      setFailure({ message: 'plugins.installFailed', code: logFailure(code, 'W_PLUGINS_FAILED') }),
    [],
  )

  const offered = useCallback((next: StagedPlugin) => {
    setFailure(undefined)
    setStaged(next)
  }, [])

  const install = () => {
    if (!staged) return
    setStaged(undefined)
    void settle(installPlugin(staged.token), 'plugins.installFailed')
  }

  const cancel = () => {
    if (!staged) return
    setStaged(undefined)
    void cancelInstall(staged.token).catch(() => console.warn('W_PLUGIN_CANCEL_FAILED'))
  }

  return (
    <section className="settings-section" aria-labelledby="plugins-title">
      <h2 id="plugins-title" className="visually-hidden">
        {t('plugins.title')}
      </h2>
      <p>{t('plugins.detail')}</p>
      {failure ? (
        <p role="alert" className="settings-error">
          {failureText(failure.message, failure.code)}
        </p>
      ) : null}
      <OfficialPlugins onStaged={offered} onFailure={catalogFailed} />
      <SettingsSection title="plugins.installTitle">
        <Setting label="plugins.installLabel" description={t('plugins.installHint')}>
          <div className="settings-buttons">
            <button type="button" className="button" onClick={() => void pick('folder')}>
              {t('plugins.installFolder')}
            </button>
            <button type="button" className="button" onClick={() => void pick('archive')}>
              {t('plugins.installArchive')}
            </button>
          </div>
        </Setting>
      </SettingsSection>
      {plugins === undefined ? null : (
        <SettingsSection title="plugins.installedTitle">
          {plugins.length === 0 ? (
            <p>{t('plugins.empty')}</p>
          ) : (
            <ul className="plugin-list" aria-label={t('plugins.listLabel')}>
              {plugins.map((p) => {
                const m = p.manifest
                const titleId = `plugin-${m.id}`
                return (
                  <Fragment key={m.id}>
                    <li className="setting setting-toggle plugin-row" aria-labelledby={titleId}>
                      <div className="setting-text">
                        <span id={titleId} className="setting-label">
                          {m.name}
                        </span>
                        <span className="setting-description">
                          {m.author
                            ? format(t('plugins.versionBy'), {
                                version: m.version,
                                author: m.author,
                              })
                            : format(t('plugins.version'), { version: m.version })}
                        </span>
                        {m.description ? (
                          <span className="setting-description">{m.description}</span>
                        ) : null}
                        <Permissions list={p.granted} label="plugins.permissions" />
                      </div>
                      <div className="setting-control">
                        <input
                          type="checkbox"
                          role="switch"
                          className="plugin-switch"
                          checked={p.enabled}
                          aria-label={format(t('plugins.on'), { name: m.name })}
                          onChange={(e) =>
                            void settle(
                              setPluginEnabled(m.id, e.currentTarget.checked),
                              'plugins.changeFailed',
                            )
                          }
                        />
                        <button
                          type="button"
                          className="button"
                          aria-label={format(t('plugins.removeLabel'), { name: m.name })}
                          onClick={() => setRemoving(p)}
                        >
                          {t('plugins.remove')}
                        </button>
                      </div>
                    </li>
                    {m.contributes.settings.length > 0 ? (
                      <PluginSettings plugin={p} onFailure={settingFailed} />
                    ) : null}
                  </Fragment>
                )
              })}
            </ul>
          )}
        </SettingsSection>
      )}
      {staged ? <Review staged={staged} onInstall={install} onCancel={cancel} /> : null}
      {removing ? (
        <ConfirmDialog
          destructive
          message={format(t('plugins.removeConfirm'), { name: removing.manifest.name })}
          detail={t('plugins.removeDetail')}
          confirm={t('plugins.removeButton')}
          onConfirm={() => {
            const id = removing.manifest.id
            setRemoving(undefined)
            void settle(removePlugin(id), 'plugins.changeFailed')
          }}
          onCancel={() => setRemoving(undefined)}
        />
      ) : null}
    </section>
  )
}
