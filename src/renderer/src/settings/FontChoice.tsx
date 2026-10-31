import { useEffect, useState } from 'react'
import {
  FONT_FAMILIES,
  FONT_SLOTS,
  slotFont,
  type EditorSettings,
  type FontFamilyId,
  type FontSlot,
} from '../../../core/editorSettings'
import { errorCode } from '../../../core/errors'
import { importFont, importedFonts, installedFonts, type FontFile } from '../fonts'
import { format, t, type MessageKey } from '../i18n'
import { Select, Setting, SettingsSection } from './controls'

const FONT_LABELS: Readonly<Record<FontFamilyId, MessageKey>> = {
  system: 'editorSettings.font.system',
  mono: 'editorSettings.font.mono',
  menlo: 'editorSettings.font.menlo',
  monaco: 'editorSettings.font.monaco',
  courierNew: 'editorSettings.font.courierNew',
  installed: 'editorSettings.font.installed',
  imported: 'editorSettings.font.imported',
}

const SLOT_SECTIONS: Readonly<Record<FontSlot, { title: MessageKey; hint: MessageKey }>> = {
  app: {
    title: 'editorSettings.appFont',
    hint: 'editorSettings.appFontHint',
  },
  note: {
    title: 'editorSettings.noteFont',
    hint: 'editorSettings.noteFontHint',
  },
  code: {
    title: 'editorSettings.codeFont',
    hint: 'editorSettings.codeFontHint',
  },
}

export function FontSection({
  slot,
  settings,
  change,
  id,
}: {
  slot: FontSlot
  settings: EditorSettings
  change: (patch: Partial<EditorSettings>) => void
  id: (name: string) => string
}) {
  const section = SLOT_SECTIONS[slot]
  const own = (name: string) => id(`${slot}-${name}`)
  return (
    <SettingsSection title={section.title}>
      <Setting
        label="editorSettings.fontFamily"
        description={t(section.hint)}
        htmlFor={own('font')}
        descriptionId={own('font-hint')}
      >
        <Select
          id={own('font')}
          value={slotFont(settings, slot).family}
          aria-describedby={own('font-hint')}
          onChange={(e) =>
            change({ [FONT_SLOTS[slot].family]: e.currentTarget.value as FontFamilyId })
          }
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f} value={f}>
              {t(FONT_LABELS[f])}
            </option>
          ))}
        </Select>
      </Setting>
      <FontChoice slot={slot} settings={settings} change={change} id={own} />
    </SettingsSection>
  )
}

/**
 * The font under a slot's Font Family when it names one of the user's own:
 * an installed family, or an imported file with Import Font… beside it. An
 * imported font that is no longer in the fonts folder says the slot's
 * default font shows instead.
 */
export function FontChoice({
  slot,
  settings,
  change,
  id,
}: {
  slot: FontSlot
  settings: EditorSettings
  change: (patch: Partial<EditorSettings>) => void
  id: (name: string) => string
}) {
  const keys = FONT_SLOTS[slot]
  const font = slotFont(settings, slot)
  const kind = font.family
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
    const names = withChosen(installed ?? [], font.installed)
    return (
      <Setting
        label="editorSettings.installedFont"
        description={t('editorSettings.installedFontHint')}
        htmlFor={id('installed-font')}
        descriptionId={id('installed-font-hint')}
      >
        <Select
          id={id('installed-font')}
          value={font.installed ?? ''}
          aria-describedby={id('installed-font-hint')}
          onChange={(e) => change({ [keys.installed]: e.currentTarget.value || null })}
        >
          <option value="">{t('editorSettings.chooseFont')}</option>
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
      </Setting>
    )
  }

  if (kind !== 'imported') return null
  const files = imported ?? []
  const chosen = font.imported
  const missing = imported !== undefined && chosen !== null && !files.some((f) => f.id === chosen)
  const add = () =>
    void importFont().then(
      (file) => {
        setImportError(undefined)
        if (!file) return
        setImported((list) => [...(list ?? []).filter((f) => f.id !== file.id), file])
        change({ [keys.imported]: file.id })
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
        <Select
          id={id('imported-font')}
          value={chosen ?? ''}
          aria-describedby={id('imported-font-hint')}
          onChange={(e) => change({ [keys.imported]: e.currentTarget.value || null })}
        >
          <option value="">{t('editorSettings.chooseFont')}</option>
          {missing ? <option value={chosen}>{chosen}</option> : null}
          {files.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
        <button type="button" className="button" onClick={add}>
          {t('editorSettings.importFont')}
        </button>
      </div>
    </Setting>
  )
}

function withChosen(names: string[], chosen: string | null): string[] {
  return chosen === null || names.includes(chosen) ? names : [chosen, ...names]
}
