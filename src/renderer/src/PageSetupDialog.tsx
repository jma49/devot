import { useLayoutEffect, useRef, useState } from 'react'
import {
  PAGE_MARGINS,
  PAGE_PAPERS,
  PAGE_SLOT_MAX_CHARS,
  type EditorSettings,
} from '../../core/editorSettings'
import { editorSettings } from './editorSettings'
import { t } from './i18n'

const PAGE_SETUP_KEYS = [
  'pagePaper',
  'pageMargins',
  'pageHeaderLeft',
  'pageHeaderCenter',
  'pageHeaderRight',
  'pageFooterLeft',
  'pageFooterCenter',
  'pageFooterRight',
  'pageSkipFirst',
  'pageRules',
] as const satisfies readonly (keyof EditorSettings)[]

export type PageSetup = Pick<EditorSettings, (typeof PAGE_SETUP_KEYS)[number]>

type SlotKey = Extract<keyof PageSetup, `page${'Header' | 'Footer'}${string}`>

const BANDS = [
  {
    label: 'pageSetup.header',
    slots: ['pageHeaderLeft', 'pageHeaderCenter', 'pageHeaderRight'],
  },
  {
    label: 'pageSetup.footer',
    slots: ['pageFooterLeft', 'pageFooterCenter', 'pageFooterRight'],
  },
] as const satisfies readonly { label: string; slots: readonly SlotKey[] }[]

const SLOT_LABELS = ['pageSetup.left', 'pageSetup.center', 'pageSetup.right'] as const

/** The page setup in the settings now. */
export const currentPageSetup = (settings: EditorSettings = editorSettings()): PageSetup =>
  Object.fromEntries(PAGE_SETUP_KEYS.map((key) => [key, settings[key]])) as PageSetup

/** Text a slot can hold: control characters (from a paste) are dropped. */
const slotText = (value: string) => value.replace(/\p{Cc}/gu, '')

/**
 * Page Setup, before Print and Export as PDF: the paper, the margins and
 * the header and footer. Print or Export (Return) hands back the setup to
 * remember and use; Escape or Cancel prints nothing.
 */
export function PageSetupDialog(props: {
  action: 'print' | 'exportPdf'
  onConfirm: (setup: PageSetup) => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const go = useRef<HTMLButtonElement>(null)
  const [setup, setSetup] = useState(() => currentPageSetup())
  const change = (patch: Partial<PageSetup>) => setSetup((now) => ({ ...now, ...patch }))
  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    // showModal focuses the first control, the Paper pop-up; Return should print.
    go.current?.focus()
    return () => el?.close()
  }, [])

  return (
    <dialog
      ref={dialog}
      className="sheet page-setup"
      aria-labelledby="page-setup-title"
      onCancel={(e) => {
        e.preventDefault()
        props.onCancel()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          props.onConfirm(setup)
        }}
      >
        <h2 id="page-setup-title" className="sheet-title">
          {t('pageSetup.title')}
        </h2>
        <div className="page-setup-choices">
          <label className="page-setup-choice">
            <span className="sheet-detail">{t('pageSetup.paper')}</span>
            <select
              value={setup.pagePaper}
              onChange={(e) => change({ pagePaper: e.target.value as PageSetup['pagePaper'] })}
            >
              {PAGE_PAPERS.map((paper) => (
                <option key={paper} value={paper}>
                  {t(`pageSetup.paper.${paper}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="page-setup-choice">
            <span className="sheet-detail">{t('pageSetup.margins')}</span>
            <select
              value={setup.pageMargins}
              onChange={(e) => change({ pageMargins: e.target.value as PageSetup['pageMargins'] })}
            >
              {PAGE_MARGINS.map((margins) => (
                <option key={margins} value={margins}>
                  {t(`pageSetup.margins.${margins}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {BANDS.map((band) => (
          <fieldset key={band.label} className="page-setup-band">
            <legend className="sheet-detail">{t(band.label)}</legend>
            {band.slots.map((key, i) => (
              <input
                key={key}
                className="pick-filter"
                type="text"
                aria-label={`${t(band.label)} ${t(SLOT_LABELS[i]!)}`}
                placeholder={t(SLOT_LABELS[i]!)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                maxLength={PAGE_SLOT_MAX_CHARS}
                value={setup[key]}
                onChange={(e) => change({ [key]: slotText(e.target.value) })}
              />
            ))}
          </fieldset>
        ))}
        <p className="page-setup-fields">{t('pageSetup.fields')}</p>
        <label className="page-setup-check">
          <input
            type="checkbox"
            checked={setup.pageSkipFirst}
            onChange={(e) => change({ pageSkipFirst: e.target.checked })}
          />
          {t('pageSetup.skipFirst')}
        </label>
        <label className="page-setup-check">
          <input
            type="checkbox"
            checked={setup.pageRules}
            onChange={(e) => change({ pageRules: e.target.checked })}
          />
          {t('pageSetup.rules')}
        </label>
        <div className="confirm-actions">
          <button type="button" className="button" onClick={props.onCancel}>
            {t('dialog.cancel')}
          </button>
          <button type="submit" className="button button-default" ref={go}>
            {t(props.action === 'print' ? 'pageSetup.print' : 'pageSetup.export')}
          </button>
        </div>
      </form>
    </dialog>
  )
}
