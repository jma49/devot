import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { errorCode } from '../backups'
import { shortcutLabel } from '../commands/keys'
import { QUICK_CAPTURE_KEY } from '../commands/registry'
import type { ListDatesStyle } from '../../../core/editorSettings'
import { useEditorSetting } from '../editorSettings'
import { format, t, type MessageKey } from '../i18n'
import { readNotebooks, subscribeNotebooks } from '../notebookChoices'
import { checkForUpdates, startUpdateStatus, updateStatusText, useUpdateStatus } from '../updates'
import { cliToolFailure } from './cliTool'
import { Select, Setting, SettingsSection, SettingToggle, useSettingsChange } from './controls'
import {
  cliToolStatus,
  installCliTool,
  openDataFolder,
  showBackups,
  uninstallCliTool,
  type CliToolState,
  type CliToolStatus,
} from './window'

const indented = (name: string, depth: number) => `${'  '.repeat(depth)}${name}`

/**
 * The notebooks as one string, so the store's snapshot is stable between
 * changes (a new array each read would re-render forever).
 */
const notebooksJson = () => JSON.stringify(readNotebooks())

const CLI_TOOL_PATH = '/usr/local/bin/devot'

const CLI_TOOL_TEXT: Readonly<Record<CliToolState, MessageKey>> = {
  installed: 'generalSettings.commandLineInstalled',
  absent: 'generalSettings.commandLineAbsent',
  other: 'generalSettings.commandLineOther',
  unavailable: 'generalSettings.commandLineUnavailable',
}

export function GeneralSection() {
  const [error, setError] = useState<{ message: MessageKey; code: string }>()
  const [saveError, change] = useSettingsChange()
  const ids = useId()
  const [cliTool, setCliTool] = useState<CliToolStatus>()
  const [cliBusy, setCliBusy] = useState(false)
  useEffect(() => {
    let live = true
    cliToolStatus().then(
      (status) => live && setCliTool(status),
      () => console.warn('W_CLI_TOOL_STATUS_FAILED'),
    )
    return () => {
      live = false
    }
  }, [])
  const changeCliTool = () => {
    setCliBusy(true)
    run(
      () =>
        (cliTool?.state === 'installed' ? uninstallCliTool() : installCliTool())
          .then(setCliTool)
          .finally(() => setCliBusy(false)),
      cliToolFailure,
    )
  }
  const stored = useEditorSetting('defaultNotebook')
  const listDates = useEditorSetting('listDates')
  const boardDropped = useEditorSetting('boardDropped')
  const activityStrip = useEditorSetting('activityStrip')
  const autoDownload = useEditorSetting('autoDownloadUpdates')
  const menuBar = useEditorSetting('menuBar')
  useEffect(() => startUpdateStatus(), [])
  const update = useUpdateStatus()
  const busy = update.state === 'checking' || update.state === 'downloading'
  const notebooks = JSON.parse(
    useSyncExternalStore(subscribeNotebooks, notebooksJson),
  ) as ReturnType<typeof readNotebooks>
  const run = (
    action: () => Promise<void>,
    message: MessageKey | ((code: string) => MessageKey),
  ) => {
    setError(undefined)
    action().then(
      () => setError(undefined),
      (e: unknown) => {
        const code = errorCode(e)
        setError({ message: typeof message === 'function' ? message(code) : message, code })
      },
    )
  }
  // A notebook deleted since it was chosen shows as None; the setting itself
  // is left alone (the window ignores a notebook that is gone).
  const shown = notebooks.some((n) => n.id === stored) ? stored : ''

  return (
    <section className="settings-section" aria-labelledby="general-title">
      <h2 id="general-title" className="visually-hidden">
        {t('generalSettings.title')}
      </h2>
      {error ? (
        <p role="alert" className="settings-error">
          {format(t(error.message), { code: error.code })}
        </p>
      ) : null}
      {saveError ? (
        <p role="alert" className="settings-error">
          {format(t('editorSettings.failed'), { code: saveError })}
        </p>
      ) : null}
      <SettingsSection title="generalSettings.defaults">
        <Setting
          label="generalSettings.defaultNotebook"
          description={t('generalSettings.defaultNotebookHint')}
          htmlFor={`${ids}-notebook`}
          descriptionId={`${ids}-notebook-hint`}
        >
          <Select
            id={`${ids}-notebook`}
            value={shown ?? ''}
            aria-describedby={`${ids}-notebook-hint`}
            onChange={(e) => change({ defaultNotebook: e.currentTarget.value || null })}
          >
            <option value="">{t('generalSettings.noNotebook')}</option>
            {notebooks.map((n) => (
              <option key={n.id} value={n.id}>
                {indented(n.name, n.depth)}
              </option>
            ))}
          </Select>
        </Setting>
        <Setting
          label="generalSettings.listDates"
          description={t('generalSettings.listDatesHint')}
          htmlFor={`${ids}-dates`}
          descriptionId={`${ids}-dates-hint`}
        >
          <Select
            id={`${ids}-dates`}
            value={listDates}
            aria-describedby={`${ids}-dates-hint`}
            onChange={(e) => change({ listDates: e.currentTarget.value as ListDatesStyle })}
          >
            <option value="relative">{t('generalSettings.listDates.relative')}</option>
            <option value="absolute">{t('generalSettings.listDates.absolute')}</option>
          </Select>
        </Setting>
        <SettingToggle
          label="generalSettings.boardDropped"
          description="generalSettings.boardDroppedHint"
          checked={boardDropped}
          onChange={(on) => change({ boardDropped: on })}
        />
        <SettingToggle
          label="generalSettings.activityStrip"
          description="generalSettings.activityStripHint"
          checked={activityStrip}
          onChange={(on) => change({ activityStrip: on })}
        />
      </SettingsSection>
      <SettingsSection title="generalSettings.data">
        <Setting
          label="generalSettings.dataFolder"
          description={t('generalSettings.dataFolderHint')}
          descriptionId={`${ids}-data`}
        >
          <button
            type="button"
            className="button"
            aria-describedby={`${ids}-data`}
            onClick={() => run(openDataFolder, 'generalSettings.openFailed')}
          >
            {t('generalSettings.openDataFolder')}
          </button>
        </Setting>
        <Setting
          label="generalSettings.backups"
          description={t('backups.detail')}
          descriptionId={`${ids}-backups`}
        >
          <button
            type="button"
            className="button"
            aria-describedby={`${ids}-backups`}
            onClick={() => run(showBackups, 'generalSettings.backupsFailed')}
          >
            {t('generalSettings.showBackups')}
          </button>
        </Setting>
      </SettingsSection>
      <SettingsSection title="generalSettings.commandLine">
        <Setting
          label="generalSettings.commandLineTool"
          description={format(t(CLI_TOOL_TEXT[cliTool?.state ?? 'absent']), {
            path: cliTool?.path ?? CLI_TOOL_PATH,
          })}
          descriptionId={`${ids}-cli`}
        >
          <button
            type="button"
            className="button"
            disabled={!cliTool || cliTool.state === 'unavailable' || cliBusy}
            aria-describedby={`${ids}-cli`}
            onClick={changeCliTool}
          >
            {t(
              cliTool?.state === 'installed'
                ? 'generalSettings.uninstall'
                : 'generalSettings.install',
            )}
          </button>
        </Setting>
      </SettingsSection>
      <SettingsSection title="generalSettings.menuBar">
        <SettingToggle
          label="generalSettings.keepInMenuBar"
          description="generalSettings.keepInMenuBarHint"
          values={{ shortcut: shortcutLabel(QUICK_CAPTURE_KEY) }}
          checked={menuBar}
          onChange={(on) => change({ menuBar: on })}
        />
      </SettingsSection>
      <SettingsSection title="generalSettings.updates">
        <SettingToggle
          label="generalSettings.autoDownloadUpdates"
          description="generalSettings.autoDownloadUpdatesHint"
          checked={autoDownload}
          onChange={(on) => change({ autoDownloadUpdates: on })}
        />
        <Setting
          label="generalSettings.checkForUpdates"
          description={updateStatusText(update)}
          descriptionId={`${ids}-updates`}
        >
          <button
            type="button"
            className="button"
            disabled={busy}
            aria-describedby={`${ids}-updates`}
            onClick={() => void checkForUpdates()}
          >
            {t('generalSettings.checkNow')}
          </button>
        </Setting>
      </SettingsSection>
    </section>
  )
}
