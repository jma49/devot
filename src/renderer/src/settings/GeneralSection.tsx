import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { errorCode } from '../backups'
import type { ListDatesStyle } from '../../../core/editorSettings'
import { useEditorSetting } from '../editorSettings'
import { format, t, type MessageKey } from '../i18n'
import { readNotebooks, subscribeNotebooks } from '../notebookChoices'
import { checkForUpdates, startUpdateStatus, updateStatusText, useUpdateStatus } from '../updates'
import { Setting, SettingToggle, SettingsSection, useSettingsChange } from './controls'
import { openDataFolder, showBackups } from './window'

const indented = (name: string, depth: number) => `${'  '.repeat(depth)}${name}`

/**
 * The notebooks as one string, so the store's snapshot is stable between
 * changes (a new array each read would re-render forever).
 */
const notebooksJson = () => JSON.stringify(readNotebooks())

export function GeneralSection() {
  const [error, setError] = useState<{ message: MessageKey; code: string }>()
  const [saveError, change] = useSettingsChange()
  const ids = useId()
  const stored = useEditorSetting('defaultNotebook')
  const listDates = useEditorSetting('listDates')
  const autoDownload = useEditorSetting('autoDownloadUpdates')
  useEffect(() => startUpdateStatus(), [])
  const update = useUpdateStatus()
  const busy = update.state === 'checking' || update.state === 'downloading'
  const notebooks = JSON.parse(
    useSyncExternalStore(subscribeNotebooks, notebooksJson),
  ) as ReturnType<typeof readNotebooks>
  const run = (action: () => Promise<void>, message: MessageKey) => {
    setError(undefined)
    action().then(
      () => setError(undefined),
      (e: unknown) => setError({ message, code: errorCode(e) }),
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
      <SettingsSection icon="settings.defaults" title="generalSettings.defaults">
        <Setting
          label="generalSettings.defaultNotebook"
          description={t('generalSettings.defaultNotebookHint')}
          htmlFor={`${ids}-notebook`}
          descriptionId={`${ids}-notebook-hint`}
        >
          <select
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
          </select>
        </Setting>
        <Setting
          label="generalSettings.listDates"
          description={t('generalSettings.listDatesHint')}
          htmlFor={`${ids}-dates`}
          descriptionId={`${ids}-dates-hint`}
        >
          <select
            id={`${ids}-dates`}
            value={listDates}
            aria-describedby={`${ids}-dates-hint`}
            onChange={(e) => change({ listDates: e.currentTarget.value as ListDatesStyle })}
          >
            <option value="relative">{t('generalSettings.listDates.relative')}</option>
            <option value="absolute">{t('generalSettings.listDates.absolute')}</option>
          </select>
        </Setting>
      </SettingsSection>
      <SettingsSection icon="settings.data" title="generalSettings.data">
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
      <SettingsSection icon="settings.updates" title="generalSettings.updates">
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
