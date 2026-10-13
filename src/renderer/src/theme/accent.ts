// Follows the macOS accent colour. The generated tokens read
// `--system-accent-<role>-<appearance>` (role: fill, text or selection) and
// fall back to Devot teal, so Multicolor only needs the overrides removed.
//
// The system gives one colour per appearance, but Devot draws it two ways:
// as a fill under white text (selections, buttons) and as text or a link on
// the paper surfaces. Yellow or green cannot do either as it is (about 1.6:1
// and 2.4:1), so each role gets the system colour moved toward black or white
// only as far as WCAG AA (4.5:1) needs; a colour that passes is left alone.
// The editor selection is a solid tint of that fill (`selectionTint`).

import { invoke } from '../ipc'
import { composite, contrastRatio, parseColor, readableOn, toHex, type Rgb } from './contrast'
import { dark, light } from './tokens'

export interface AccentInfo {
  multicolor: boolean
  light: string | null
  dark: string | null
}

export interface StyleTarget {
  setProperty(name: string, value: string): void
  removeProperty(name: string): void
}

const HEX = /^#[0-9a-f]{6}$/i
type Appearance = 'light' | 'dark'
const ROLES = ['fill', 'text', 'selection'] as const
const varName = (role: (typeof ROLES)[number], appearance: Appearance) =>
  `--system-accent-${role}-${appearance}`

/** AA for body text is 4.5:1; the extra keeps the colour clear of rounding and translucent material. */
const TARGET = 4.6

const THEMES = { light, dark } as const

/**
 * How far the editor selection stands from the editor and from the active
 * line (WCAG ratio). The text colours the editor draws keep 4.5:1 on it,
 * except the tertiary one (rules, fences, comments), which keeps 3:1.
 */
export const SELECTION_CONTRAST = 1.3

/**
 * The editor selection for an accent fill: the fill mixed into the editor
 * surface, in 1% steps, until it stands `SELECTION_CONTRAST` from the editor
 * and, with the active line's tint over it (CodeMirror draws the selection in
 * a layer under the lines), from the active line. Solid, so it is the same
 * colour whatever it is drawn over.
 */
export function selectionTint(fill: Rgb, appearance: Appearance): Rgb {
  const theme = THEMES[appearance]
  const editor = parseColor(theme['color.surface.editor']).rgb
  const track = parseColor(theme['color.fill.track'])
  const activeLine = composite(track, editor)
  for (let step = 1; step <= 100; step++) {
    const tint = composite({ rgb: fill, alpha: step / 100 }, editor).map(Math.round) as Rgb
    if (
      contrastRatio(tint, editor) >= SELECTION_CONTRAST &&
      contrastRatio(composite(track, tint), activeLine) >= SELECTION_CONTRAST
    )
      return tint
  }
  return fill
}

/**
 * What accent text can sit on: the surfaces, the track and selected-row fills
 * over them, and the editor selection over the editor and under its active line.
 */
function textBackdrops(appearance: Appearance, selection: Rgb): Rgb[] {
  const theme = THEMES[appearance]
  const surfaces = (['list', 'editor', 'sidebar-opaque'] as const).map(
    (name) => parseColor(theme[`color.surface.${name}`]).rgb,
  )
  const track = parseColor(theme['color.fill.track'])
  const fills = [track, parseColor(theme['color.fill.row-selected-unemphasized'])]
  return [
    ...surfaces,
    ...surfaces.flatMap((s) => fills.map((f) => composite(f, s))),
    selection,
    composite(track, selection),
  ]
}

/**
 * The system accent for one appearance as a fill under the on-fill colour
 * (white), as the editor selection, and as text on the surfaces and the
 * selection, each at AA.
 */
export function readableAccent(
  hex: string,
  appearance: Appearance,
): Record<(typeof ROLES)[number], string> {
  const accent = parseColor(hex).rgb
  const theme = THEMES[appearance]
  const onFill = parseColor(theme['color.accent.on-fill']).rgb
  const fill = toHex(readableOn(accent, [onFill], 'darker', TARGET))
  const selection = selectionTint(parseColor(fill).rgb, appearance)
  return {
    fill,
    selection: toHex(selection),
    // Light text darkens toward black on paper; dark text lightens on the night surfaces.
    text: toHex(
      readableOn(
        accent,
        textBackdrops(appearance, selection),
        appearance === 'light' ? 'darker' : 'lighter',
        TARGET,
      ),
    ),
  }
}

export function applyAccent(info: AccentInfo, style: StyleTarget): void {
  const usable = !info.multicolor && HEX.test(info.light ?? '') && HEX.test(info.dark ?? '')
  for (const appearance of ['light', 'dark'] as const) {
    const adjusted = usable ? readableAccent(info[appearance]!, appearance) : null
    for (const role of ROLES) {
      if (adjusted) style.setProperty(varName(role, appearance), adjusted[role])
      else style.removeProperty(varName(role, appearance))
    }
  }
}

export const ACCENT_EVENT = 'devot://accent-changed'

/** Applies the current accent and keeps it in sync. Returns a stop function. */
export async function followSystemAccent(style: StyleTarget): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  applyAccent(await invoke<AccentInfo>('system_accent'), style)
  return listen<AccentInfo>(ACCENT_EVENT, (event) => applyAccent(event.payload, style))
}
