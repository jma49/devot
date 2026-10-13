import { useId, useState } from 'react'
import { errorCode } from '../backups'
import { format, t, type MessageKey } from '../i18n'
import { FormGroup, FormHint, FormRow } from './controls'
import { openDataFolder, showBackups } from './window'

/**
 * Settings > General: Open Data Folder shows the folder Devot keeps the
 * notes, backups, logs and settings in (only that folder: the command takes
 * no path), and Show Backups… opens the main window's Backups dialog, as
 * Devot > Backups… does.
 */
export function GeneralSection() {
  const [error, setError] = useState<{ message: MessageKey; code: string }>()
  const ids = useId()
  const run = (action: () => Promise<void>, message: MessageKey) => {
    setError(undefined)
    action().then(
      () => setError(undefined),
      (e: unknown) => setError({ message, code: errorCode(e) }),
    )
  }

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
      <FormGroup>
        <FormRow label="generalSettings.dataFolder">
          <button
            type="button"
            className="button"
            aria-describedby={`${ids}-data`}
            onClick={() => run(openDataFolder, 'generalSettings.openFailed')}
          >
            {t('generalSettings.openDataFolder')}
          </button>
          <FormHint id={`${ids}-data`}>{t('generalSettings.dataFolderHint')}</FormHint>
        </FormRow>
        <FormRow label="generalSettings.backups">
          <button
            type="button"
            className="button"
            aria-describedby={`${ids}-backups`}
            onClick={() => run(showBackups, 'generalSettings.backupsFailed')}
          >
            {t('generalSettings.showBackups')}
          </button>
          <FormHint id={`${ids}-backups`}>{t('backups.detail')}</FormHint>
        </FormRow>
      </FormGroup>
    </section>
  )
}
