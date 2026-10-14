import { useEffect, useState } from 'react'
import type { EditorSettings } from '../../../core/editorSettings'
import { errorCode } from '../../../core/errors'
import { importFont, importedFonts, installedFonts, type FontFile } from '../fonts'
import { format, t } from '../i18n'
import { Setting } from './controls'

/**
 * The font under Font Family when it names one of the user's own: an
 * installed family, or an imported file with Import Font… beside it. An
 * imported font that is no longer in the fonts folder says the editor shows
 * SF Mono instead.
 */
export function FontChoice({
  settings,
  change,
  id,
}: {
  settings: EditorSettings
  change: (patch: Partial<EditorSettings>) => void
  id: (name: string) => string
}) {
  const kind = settings.fontFamily
  const [installed, setInstalled] = useState<string[]>()
  const [imported, setImported] = useState<FontFile[]>()
  const [importError, setImportError] = useState<string>()

  useEffect(() => {
    if (kind !== 'installed' || installed) return
    installedFonts().then(setInstalled, () => setInstalled([]))
  }, [kind, installed])
  useEffect(() => {
    if (kind !== 'imported' || imported) return
    importedFonts().then(setImported, () => setImported([]))
  }, [kind, imported])

  if (kind === 'installed') {
    const names = withChosen(installed ?? [], settings.installedFont)
    return (
      <Setting
        label="editorSettings.installedFont"
        description={t('editorSettings.installedFontHint')}
        htmlFor={id('installed-font')}
        descriptionId={id('installed-font-hint')}
      >
        <select
          id={id('installed-font')}
          value={settings.installedFont ?? ''}
          aria-describedby={id('installed-font-hint')}
          onChange={(e) => change({ installedFont: e.currentTarget.value || null })}
        >
          <option value="">{t('editorSettings.chooseFont')}</option>
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </Setting>
    )
  }

  if (kind !== 'imported') return null
  const files = imported ?? []
  const chosen = settings.importedFont
  const missing = imported !== undefined && chosen !== null && !files.some((f) => f.id === chosen)
  const add = () =>
    void importFont().then(
      (font) => {
        setImportError(undefined)
        if (!font) return
        setImported((list) => [...(list ?? []).filter((f) => f.id !== font.id), font])
        change({ importedFont: font.id })
      },
      (e: unknown) => setImportError(errorCode(e)),
    )
  const description = importError
    ? format(t('editorSettings.importFontFailed'), { code: importError })
    : missing
      ? t('editorSettings.importedFontMissing')
      : t('editorSettings.importedFontHint')
  return (
    <Setting
      label="editorSettings.importedFont"
      description={description}
      htmlFor={id('imported-font')}
      descriptionId={id('imported-font-hint')}
    >
      <div className="settings-buttons">
        <select
          id={id('imported-font')}
          value={chosen ?? ''}
          aria-describedby={id('imported-font-hint')}
          onChange={(e) => change({ importedFont: e.currentTarget.value || null })}
        >
          <option value="">{t('editorSettings.chooseFont')}</option>
          {missing ? <option value={chosen}>{chosen}</option> : null}
          {files.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <button type="button" className="button" onClick={add}>
          {t('editorSettings.importFont')}
        </button>
      </div>
    </Setting>
  )
}

/** The names with the chosen one in them, so the menu shows what is in effect. */
function withChosen(names: string[], chosen: string | null): string[] {
  return chosen === null || names.includes(chosen) ? names : [chosen, ...names]
}
