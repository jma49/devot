import { useId, useMemo } from 'react'
import {
  CURSOR_SCROLL_MARGIN_MAX,
  FONT_SLOT_ORDER,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_WEIGHTS,
  INDENT_UNITS,
  LINE_HEIGHTS,
  LINE_WRAPPING_MODES,
  LIST_MARKERS,
  PASTE_URL_STYLES,
  TAB_WIDTHS,
  type FontWeightId,
  type IndentUnitId,
  type LineWrappingMode,
  type ListMarker,
  type PasteUrlStyle,
} from '../../../core/editorSettings'
import { commandKeys } from '../commands/registry'
import { shortcutLabel } from '../commands/keys'
import { useKeymap } from '../commands/shortcutSettings'
import { useEditorSettings } from '../editorSettings'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { Setting, SettingToggle, SettingsSection, useSettingsChange } from './controls'
import { FontSection } from './FontChoice'
import { useTypedNumber } from './typedNumber'

const INDENT_LABELS: Readonly<Record<IndentUnitId, MessageKey>> = {
  spaces2: 'editorSettings.indent.spaces2',
  spaces4: 'editorSettings.indent.spaces4',
  tab: 'editorSettings.indent.tab',
}

const MARKER_LABELS: Readonly<Record<ListMarker, MessageKey>> = {
  '-': 'editorSettings.marker.dash',
  '*': 'editorSettings.marker.star',
  '+': 'editorSettings.marker.plus',
}

const WRAPPING_LABELS: Readonly<Record<LineWrappingMode, MessageKey>> = {
  off: 'editorSettings.lineWrapping.off',
  all: 'editorSettings.lineWrapping.all',
  prose: 'editorSettings.lineWrapping.prose',
  unwrapAtCursor: 'editorSettings.lineWrapping.unwrapAtCursor',
}

const PASTE_URL_LABELS: Readonly<Record<PasteUrlStyle, MessageKey>> = {
  plain: 'editorSettings.pasteUrl.plain',
  autolink: 'editorSettings.pasteUrl.autolink',
  link: 'editorSettings.pasteUrl.link',
  choose: 'editorSettings.pasteUrl.choose',
}

type Flag =
  | 'toolbar'
  | 'lineNumbers'
  | 'highlightActiveLine'
  | 'inlineImages'
  | 'readableWidth'
  | 'scrollPastEnd'
  | 'spellCheck'
  | 'showInvisibles'
  | 'highlightTrailingWhitespace'

const FLAGS: Readonly<Record<Flag, { label: MessageKey; hint: MessageKey }>> = {
  toolbar: { label: 'editorSettings.toolbar', hint: 'editorSettings.toolbarHint' },
  lineNumbers: { label: 'editorSettings.lineNumbers', hint: 'editorSettings.lineNumbersHint' },
  highlightActiveLine: {
    label: 'editorSettings.highlightActiveLine',
    hint: 'editorSettings.highlightActiveLineHint',
  },
  inlineImages: { label: 'editorSettings.inlineImages', hint: 'editorSettings.inlineImagesHint' },
  readableWidth: {
    label: 'editorSettings.readableWidth',
    hint: 'editorSettings.readableWidthHint',
  },
  scrollPastEnd: {
    label: 'editorSettings.scrollPastEnd',
    hint: 'editorSettings.scrollPastEndHint',
  },
  spellCheck: { label: 'editorSettings.spellCheck', hint: 'editorSettings.spellCheckHint' },
  showInvisibles: {
    label: 'editorSettings.showInvisibles',
    hint: 'editorSettings.showInvisiblesHint',
  },
  highlightTrailingWhitespace: {
    label: 'editorSettings.highlightTrailingWhitespace',
    hint: 'editorSettings.highlightTrailingWhitespaceHint',
  },
}

/**
 * The font size description: what it is, and the keys in effect (or, when
 * any of the three has no key, so a sentence with them would have blanks,
 * the palette's commands).
 */
function fontSizeHint(): string {
  const [bigger, smaller, reset] = (
    ['view.fontBigger', 'view.fontSmaller', 'view.fontReset'] as const
  ).map((id) => commandKeys(id)[0])
  const keys =
    bigger === undefined || smaller === undefined || reset === undefined
      ? t('editorSettings.fontSizeKeysNone')
      : format(t('editorSettings.fontSizeKeys'), {
          bigger: shortcutLabel(bigger),
          smaller: shortcutLabel(smaller),
          reset: shortcutLabel(reset),
        })
  return `${t('editorSettings.fontSizeHint')} ${keys}`
}

/** A stored value the list does not offer still shows (in order). */
function withStored(list: readonly number[], stored: number): number[] {
  return list.includes(stored) ? [...list] : [...list, stored].sort((a, b) => a - b)
}

/**
 * Settings > Editing: how the note editor looks and behaves, in sections
 * (Interface, Markdown, Text Appearance, then the App, Note and Code
 * fonts). Every change is stored at
 * once and applies to the editor in every window; changes made elsewhere
 * (Cmd+= in the main window) show here as they happen.
 */
export function EditingSection() {
  const settings = useEditorSettings()
  // The font size description names the keys in effect.
  useKeymap()
  const [error, change] = useSettingsChange()
  const ids = useId()
  const locale = currentLocale()
  const decimal = useMemo(
    () => new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    [locale],
  )
  const whole = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const id = (name: string) => `${ids}-${name}`

  const fontSize = useTypedNumber({
    stored: settings.fontSize,
    min: FONT_SIZE_MIN,
    max: FONT_SIZE_MAX,
    store: (fontSize) => change({ fontSize }),
  })
  const margin = useTypedNumber({
    stored: settings.cursorScrollMargin,
    min: 0,
    max: CURSOR_SCROLL_MARGIN_MAX,
    store: (cursorScrollMargin) => change({ cursorScrollMargin }),
  })

  const flag = (key: Flag, note?: MessageKey) => (
    <SettingToggle
      key={key}
      label={FLAGS[key].label}
      description={FLAGS[key].hint}
      checked={settings[key]}
      disabled={note !== undefined}
      note={note}
      onChange={(checked) => change({ [key]: checked })}
    />
  )

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
      <SettingsSection icon="settings.interface" title="editorSettings.interface">
        {flag('toolbar')}
        {flag('lineNumbers')}
        {flag('highlightActiveLine')}
        <Setting
          label="editorSettings.lineWrapping"
          description={t('editorSettings.lineWrappingHint')}
          htmlFor={id('line-wrapping')}
          descriptionId={id('line-wrapping-hint')}
        >
          <select
            id={id('line-wrapping')}
            value={settings.lineWrapping}
            aria-describedby={id('line-wrapping-hint')}
            onChange={(e) => change({ lineWrapping: e.currentTarget.value as LineWrappingMode })}
          >
            {LINE_WRAPPING_MODES.map((m) => (
              <option key={m} value={m}>
                {t(WRAPPING_LABELS[m])}
              </option>
            ))}
          </select>
        </Setting>
        {flag('inlineImages')}
        {/* Only wrapped lines can keep to a width (see editor/settings.ts). */}
        {flag(
          'readableWidth',
          settings.lineWrapping !== 'off' ? undefined : 'editorSettings.readableWidthNote',
        )}
        {flag('scrollPastEnd')}
        <Setting
          label="editorSettings.cursorScrollMargin"
          description={t('editorSettings.cursorScrollMarginHint')}
          htmlFor={id('margin')}
          descriptionId={id('margin-hint')}
        >
          <input
            id={id('margin')}
            type="number"
            className="settings-number"
            min={0}
            max={CURSOR_SCROLL_MARGIN_MAX}
            step={1}
            value={margin.value}
            aria-describedby={id('margin-hint')}
            onChange={(e) => margin.type(e.currentTarget.value)}
            onBlur={margin.leave}
          />
        </Setting>
      </SettingsSection>
      <SettingsSection icon="settings.markdown" title="editorSettings.markdown">
        <Setting
          label="editorSettings.listMarker"
          description={t('editorSettings.listMarkerHint')}
          htmlFor={id('marker')}
          descriptionId={id('marker-hint')}
        >
          <select
            id={id('marker')}
            value={settings.listMarker}
            aria-describedby={id('marker-hint')}
            onChange={(e) => change({ listMarker: e.currentTarget.value as ListMarker })}
          >
            {LIST_MARKERS.map((m) => (
              <option key={m} value={m}>
                {t(MARKER_LABELS[m])}
              </option>
            ))}
          </select>
        </Setting>
        <Setting
          label="editorSettings.indentUnit"
          description={t('editorSettings.indentUnitHint')}
          htmlFor={id('indent')}
          descriptionId={id('indent-hint')}
        >
          <select
            id={id('indent')}
            value={settings.indentUnit}
            aria-describedby={id('indent-hint')}
            onChange={(e) => change({ indentUnit: e.currentTarget.value as IndentUnitId })}
          >
            {INDENT_UNITS.map((u) => (
              <option key={u} value={u}>
                {t(INDENT_LABELS[u])}
              </option>
            ))}
          </select>
        </Setting>
        <Setting
          label="editorSettings.tabWidth"
          description={t('editorSettings.tabWidthHint')}
          htmlFor={id('tab-width')}
          descriptionId={id('tab-width-hint')}
        >
          <select
            id={id('tab-width')}
            value={String(settings.tabWidth)}
            aria-describedby={id('tab-width-hint')}
            onChange={(e) => change({ tabWidth: Number(e.currentTarget.value) })}
          >
            {withStored(TAB_WIDTHS, settings.tabWidth).map((w) => (
              <option key={w} value={String(w)}>
                {whole.format(w)}
              </option>
            ))}
          </select>
        </Setting>
        <Setting
          label="editorSettings.pasteUrl"
          description={t('editorSettings.pasteUrlHint')}
          htmlFor={id('paste-url')}
          descriptionId={id('paste-url-hint')}
        >
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
        </Setting>
        {flag('spellCheck')}
      </SettingsSection>
      <SettingsSection icon="settings.textAppearance" title="editorSettings.textAppearance">
        <Setting
          label="editorSettings.fontSize"
          description={fontSizeHint()}
          htmlFor={id('size')}
          descriptionId={id('size-hint')}
        >
          <input
            id={id('size')}
            type="number"
            className="settings-number"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            step={1}
            value={fontSize.value}
            aria-describedby={id('size-hint')}
            onChange={(e) => fontSize.type(e.currentTarget.value)}
            onBlur={fontSize.leave}
          />
        </Setting>
        <Setting
          label="editorSettings.fontWeight"
          description={t('editorSettings.fontWeightHint')}
          htmlFor={id('weight')}
          descriptionId={id('weight-hint')}
        >
          <select
            id={id('weight')}
            value={settings.fontWeight}
            aria-describedby={id('weight-hint')}
            onChange={(e) => change({ fontWeight: e.currentTarget.value as FontWeightId })}
          >
            {FONT_WEIGHTS.map((w) => (
              <option key={w} value={w}>
                {w === 'normal' ? t('editorSettings.weight.normal') : w}
              </option>
            ))}
          </select>
        </Setting>
        <Setting
          label="editorSettings.lineHeight"
          description={t('editorSettings.lineHeightHint')}
          htmlFor={id('line-height')}
          descriptionId={id('line-height-hint')}
        >
          <select
            id={id('line-height')}
            value={String(settings.lineHeight)}
            aria-describedby={id('line-height-hint')}
            onChange={(e) => change({ lineHeight: Number(e.currentTarget.value) })}
          >
            {/* A stored height the list does not offer still shows. */}
            {withStored(LINE_HEIGHTS, settings.lineHeight).map((h) => (
              <option key={h} value={String(h)}>
                {decimal.format(h)}
              </option>
            ))}
          </select>
        </Setting>
        {flag('showInvisibles')}
        {flag('highlightTrailingWhitespace')}
      </SettingsSection>
      {FONT_SLOT_ORDER.map((slot) => (
        <FontSection key={slot} slot={slot} settings={settings} change={change} id={id} />
      ))}
      <p className="settings-note">{t('editorSettings.detail')}</p>
    </section>
  )
}
