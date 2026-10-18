import { useId, useState, useSyncExternalStore } from 'react'
import { errorCode } from '../backups'
import type { ListDatesStyle } from '../../../core/editorSettings'
import { useEditorSetting } from '../editorSettings'
import { format, t, type MessageKey } from '../i18n'
import { readNotebooks, subscribeNotebooks } from '../notebookChoices'
import { Setting, SettingsSection, useSettingsChange } from './controls'
import { openDataFolder, showBackups } from './window'

/** Indents a sub-notebook's name under its parent in a pop-up (no-break spaces). */
const indented = (name: string, depth: number) => `${'  '.repeat(depth)}${name}`

/**
 * The notebooks as one string, so the store's snapshot is stable between
 * changes (a new array each read would re-render forever).
 */
const notebooksJson = () => JSON.stringify(readNotebooks())

/**
 * Settings > General: Default Notebook (where a new note goes when the view
 * shown has no notebook; None by default), Open Data Folder (shows the
 * folder Devot keeps the notes, backups, logs and settings in; only that
 * folder: the command takes no path) and Show Backups… (opens the main
 * window's Backups dialog, as Devot > Backups… does).
 */
export function GeneralSection() {
  const [error, setError] = useState<{ message: MessageKey; code: string }>()
  const [saveError, change] = useSettingsChange()
  const ids = useId()
  const stored = useEditorSetting('defaultNotebook')
  const listDates = useEditorSetting('listDates')
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
    </section>
  )
}
