import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  FONT_FAMILIES,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  INDENT_UNITS,
  LINE_HEIGHTS,
  LIST_MARKERS,
  PASTE_URL_STYLES,
  TAB_WIDTHS,
  type FontFamilyId,
  type IndentUnitId,
  type ListMarker,
  type PasteUrlStyle,
} from '../../../core/editorSettings'
import { commandKeys } from '../commands/registry'
import { shortcutLabel } from '../commands/keys'
import { useKeymap } from '../commands/shortcutSettings'
import { useEditorSettings } from '../editorSettings'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { FormGroup, FormHint, FormRow, SettingsFlag, useSettingsChange } from './controls'

const FONT_LABELS: Readonly<Record<FontFamilyId, MessageKey>> = {
  system: 'editorSettings.font.system',
  mono: 'editorSettings.font.mono',
  menlo: 'editorSettings.font.menlo',
  monaco: 'editorSettings.font.monaco',
  courierNew: 'editorSettings.font.courierNew',
}

const INDENT_LABELS: Readonly<Record<IndentUnitId, MessageKey>> = {
  spaces2: 'editorSettings.indent.spaces2',
  spaces4: 'editorSettings.indent.spaces4',
  tab: 'editorSettings.indent.tab',
}

const MARKER_LABELS: Readonly<Record<ListMarker, MessageKey>> = {
  '-': 'editorSettings.marker.dash',
  '*': 'editorSettings.marker.star',
}

const PASTE_URL_LABELS: Readonly<Record<PasteUrlStyle, MessageKey>> = {
  plain: 'editorSettings.pasteUrl.plain',
  autolink: 'editorSettings.pasteUrl.autolink',
  link: 'editorSettings.pasteUrl.link',
}

type Flag =
  | 'lineNumbers'
  | 'lineWrapping'
  | 'readableWidth'
  | 'highlightActiveLine'
  | 'syncScroll'
  | 'inlineImages'
  | 'spellCheck'

const FLAG_LABELS: Readonly<Record<Flag, MessageKey>> = {
  lineNumbers: 'editorSettings.lineNumbers',
  lineWrapping: 'editorSettings.lineWrapping',
  readableWidth: 'editorSettings.readableWidth',
  highlightActiveLine: 'editorSettings.highlightActiveLine',
  syncScroll: 'editorSettings.syncScroll',
  inlineImages: 'editorSettings.inlineImages',
  spellCheck: 'editorSettings.spellCheck',
}

/** How long typing in the font size field pauses before the size is stored. */
const TYPING_PAUSE_MS = 400

/**
 * The font size hint: the keys in effect, or (when any of the three has no
 * key, so a sentence with them would have blanks) the palette's commands.
 */
function fontSizeHint(): string {
  const [bigger, smaller, reset] = (
    ['view.fontBigger', 'view.fontSmaller', 'view.fontReset'] as const
  ).map((id) => commandKeys(id)[0])
  if (bigger === undefined || smaller === undefined || reset === undefined) {
    return t('editorSettings.fontSizeHintNoKeys')
  }
  return format(t('editorSettings.fontSizeHint'), {
    bigger: shortcutLabel(bigger),
    smaller: shortcutLabel(smaller),
    reset: shortcutLabel(reset),
  })
}

/**
 * Settings > Editor: how the note editor looks and behaves. Every change is
 * stored at once and applies to the editor in every window; changes made
 * elsewhere (Cmd+= in the main window) show here as they happen.
 */
export function EditorSection() {
  const settings = useEditorSettings()
  // The font size hint names the keys in effect.
  useKeymap()
  const [error, change] = useSettingsChange()
  // What is typed in the font size field while it has the focus; otherwise
  // it shows the stored size (also after Cmd+= elsewhere or a refused change).
  const [typedSize, setTypedSize] = useState<string | null>(null)
  // A typed size waiting for a pause in typing, so each keystroke (or each
  // step of a held arrow key) is not stored and sent to every window.
  const sizeTimer = useRef<{ timer: ReturnType<typeof setTimeout>; size: number } | null>(null)
  useEffect(() => () => clearTimeout(sizeTimer.current?.timer), [])
  const ids = useId()
  const locale = currentLocale()
  const decimal = useMemo(
    () => new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    [locale],
  )
  const whole = useMemo(() => new Intl.NumberFormat(locale), [locale])

  // A flag with a hint is one that cannot be changed now; the hint says why.
  const flag = (key: Flag, hint?: { id: string; text: MessageKey }) => (
    <SettingsFlag
      key={key}
      label={FLAG_LABELS[key]}
      checked={settings[key]}
      disabled={hint !== undefined}
      hint={hint}
      onChange={(checked) => change({ [key]: checked })}
    />
  )

  const storeTypedSize = () => {
    const waiting = sizeTimer.current
    if (!waiting) return
    clearTimeout(waiting.timer)
    sizeTimer.current = null
    change({ fontSize: waiting.size })
  }

  const typeSize = (text: string) => {
    setTypedSize(text)
    if (sizeTimer.current) clearTimeout(sizeTimer.current.timer)
    sizeTimer.current = null
    const size = Number(text)
    if (
      text.trim() !== '' &&
      Number.isInteger(size) &&
      size >= FONT_SIZE_MIN &&
      size <= FONT_SIZE_MAX &&
      size !== settings.fontSize
    )
      sizeTimer.current = { timer: setTimeout(storeTypedSize, TYPING_PAUSE_MS), size }
  }

  const id = (name: string) => `${ids}-${name}`

  return (
    <section className="settings-section" aria-labelledby="editor-title">
      <h2 id="editor-title" className="visually-hidden">
        {t('editorSettings.title')}
      </h2>
      {error ? (
        <p role="alert" className="settings-error">
          {format(t('editorSettings.failed'), { code: error })}
        </p>
      ) : null}
      <FormGroup>
        <FormRow label="editorSettings.view">
          {flag('lineNumbers')}
          {flag('lineWrapping')}
          {/* Only wrapped lines can keep to a width (see editor/settings.ts). */}
          {flag(
            'readableWidth',
            settings.lineWrapping
              ? undefined
              : { id: id('width-hint'), text: 'editorSettings.readableWidthHint' },
          )}
          {flag('highlightActiveLine')}
          {flag('syncScroll')}
          {flag('inlineImages')}
        </FormRow>
      </FormGroup>
      <FormGroup label="editorSettings.text">
        <FormRow htmlFor={id('font')} label="editorSettings.fontFamily">
          <select
            id={id('font')}
            value={settings.fontFamily}
            onChange={(e) => change({ fontFamily: e.currentTarget.value as FontFamilyId })}
          >
            {FONT_FAMILIES.map((f) => (
              <option key={f} value={f}>
                {t(FONT_LABELS[f])}
              </option>
            ))}
          </select>
        </FormRow>
        <FormRow htmlFor={id('size')} label="editorSettings.fontSize">
          <input
            id={id('size')}
            type="number"
            className="settings-number"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            step={1}
            value={typedSize ?? String(settings.fontSize)}
            aria-describedby={id('size-hint')}
            onChange={(e) => typeSize(e.currentTarget.value)}
            onBlur={() => {
              storeTypedSize()
              setTypedSize(null)
            }}
          />
          <FormHint id={id('size-hint')}>{fontSizeHint()}</FormHint>
        </FormRow>
        <FormRow htmlFor={id('line-height')} label="editorSettings.lineHeight">
          <select
            id={id('line-height')}
            value={String(settings.lineHeight)}
            onChange={(e) => change({ lineHeight: Number(e.currentTarget.value) })}
          >
            {/* A stored height the list does not offer still shows. */}
            {(LINE_HEIGHTS.includes(settings.lineHeight)
              ? LINE_HEIGHTS
              : [...LINE_HEIGHTS, settings.lineHeight].sort((a, b) => a - b)
            ).map((h) => (
              <option key={h} value={String(h)}>
                {decimal.format(h)}
              </option>
            ))}
          </select>
        </FormRow>
      </FormGroup>
      <FormGroup label="editorSettings.typing">
        <FormRow htmlFor={id('indent')} label="editorSettings.indentUnit">
          <select
            id={id('indent')}
            value={settings.indentUnit}
            onChange={(e) => change({ indentUnit: e.currentTarget.value as IndentUnitId })}
          >
            {INDENT_UNITS.map((u) => (
              <option key={u} value={u}>
                {t(INDENT_LABELS[u])}
              </option>
            ))}
          </select>
        </FormRow>
        <FormRow htmlFor={id('tab-width')} label="editorSettings.tabWidth">
          <select
            id={id('tab-width')}
            value={String(settings.tabWidth)}
            onChange={(e) => change({ tabWidth: Number(e.currentTarget.value) })}
          >
            {(TAB_WIDTHS.includes(settings.tabWidth)
              ? TAB_WIDTHS
              : [...TAB_WIDTHS, settings.tabWidth].sort((a, b) => a - b)
            ).map((w) => (
              <option key={w} value={String(w)}>
                {whole.format(w)}
              </option>
            ))}
          </select>
        </FormRow>
        <FormRow htmlFor={id('marker')} label="editorSettings.listMarker">
          <select
            id={id('marker')}
            value={settings.listMarker}
            onChange={(e) => change({ listMarker: e.currentTarget.value as ListMarker })}
          >
            {LIST_MARKERS.map((m) => (
              <option key={m} value={m}>
                {t(MARKER_LABELS[m])}
              </option>
            ))}
          </select>
        </FormRow>
        <FormRow htmlFor={id('paste-url')} label="editorSettings.pasteUrl">
          <select
            id={id('paste-url')}
            value={settings.pasteUrl}
            aria-describedby={id('paste-url-hint')}
            onChange={(e) => change({ pasteUrl: e.currentTarget.value as PasteUrlStyle })}
          >
            {PASTE_URL_STYLES.map((p) => (
              <option key={p} value={p}>
                {t(PASTE_URL_LABELS[p])}
              </option>
            ))}
          </select>
          <FormHint id={id('paste-url-hint')}>{t('editorSettings.pasteUrlHint')}</FormHint>
        </FormRow>
        <FormRow label="editorSettings.spelling">{flag('spellCheck')}</FormRow>
      </FormGroup>
      <FormGroup>
        <FormRow>
          <FormHint>{t('editorSettings.detail')}</FormHint>
        </FormRow>
      </FormGroup>
    </section>
  )
}
