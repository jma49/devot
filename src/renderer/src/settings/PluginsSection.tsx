import { useCallback, useEffect, useRef, useState } from 'react'
import type { InstalledPlugin, PluginPermission } from '../../../core/plugins'
import { errorCode } from '../backups'
import { ConfirmDialog } from '../ConfirmDialog'
import { format, t, type MessageKey } from '../i18n'
import {
  cancelInstall,
  installPlugin,
  listPlugins,
  pickPlugin,
  removePlugin,
  setPluginEnabled,
  watchPlugins,
  type StagedPlugin,
} from '../plugins/api'

const PERMISSION_TEXT: Readonly<Record<PluginPermission, MessageKey>> = {
  'note.read': 'plugins.permission.note.read',
  'note.edit': 'plugins.permission.note.edit',
  commands: 'plugins.permission.commands',
  menus: 'plugins.permission.menus',
  keymaps: 'plugins.permission.keymaps',
  preview: 'plugins.permission.preview',
  import: 'plugins.permission.import',
  export: 'plugins.permission.export',
}

function Permissions(props: { list: readonly PluginPermission[]; label: MessageKey }) {
  if (props.list.length === 0) return <p>{t('plugins.noPermissions')}</p>
  return (
    <>
      <p>{t(props.label)}</p>
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
        (e: unknown) => setFailure({ message: 'plugins.loadFailed', code: errorCode(e) }),
      ),
    [],
  )

  useEffect(() => {
    void load()
    return watchPlugins(() => void load())
  }, [load])

  const settle = (change: Promise<unknown>, failed: MessageKey) =>
    change.then(
      () => {
        setFailure(undefined)
        return load()
      },
      (e: unknown) => setFailure({ message: failed, code: errorCode(e) }),
    )

  const pick = (kind: 'folder' | 'archive') =>
    pickPlugin(kind).then(
      (next) => {
        setFailure(undefined)
        if (next) setStaged(next)
      },
      (e: unknown) => setFailure({ message: 'plugins.installFailed', code: errorCode(e) }),
    )

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
          {format(t(failure.message), { code: failure.code })}
        </p>
      ) : null}
      <div className="settings-actions">
        <button type="button" className="button" onClick={() => void pick('folder')}>
          {t('plugins.installFolder')}
        </button>
        <button type="button" className="button" onClick={() => void pick('archive')}>
          {t('plugins.installArchive')}
        </button>
      </div>
      {plugins === undefined ? null : plugins.length === 0 ? (
        <p>{t('plugins.empty')}</p>
      ) : (
        <ul className="plugin-list" aria-label={t('plugins.listLabel')}>
          {plugins.map((p) => {
            const m = p.manifest
            const titleId = `plugin-${m.id}`
            return (
              <li key={m.id} className="plugin-row" aria-labelledby={titleId}>
                <div className="setting setting-toggle">
                  <div className="setting-text">
                    <span id={titleId} className="setting-label">
                      {m.name}
                    </span>
                    <span className="setting-description">
                      {m.author
                        ? format(t('plugins.versionBy'), { version: m.version, author: m.author })
                        : format(t('plugins.version'), { version: m.version })}
                    </span>
                    {m.description ? (
                      <span className="setting-description">{m.description}</span>
                    ) : null}
                  </div>
                  <div className="setting-control">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={p.enabled}
                      aria-label={format(t('plugins.on'), { name: m.name })}
                      onChange={(e) =>
                        void settle(
                          setPluginEnabled(m.id, e.currentTarget.checked),
                          'plugins.changeFailed',
                        )
                      }
                    />
                  </div>
                </div>
                <Permissions list={p.granted} label="plugins.permissions" />
                <div className="settings-actions">
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
            )
          })}
        </ul>
      )}
      {staged ? <Review staged={staged} onInstall={install} onCancel={cancel} /> : null}
      {removing ? (
        <ConfirmDialog
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
