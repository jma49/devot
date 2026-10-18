// Follows the macOS accent colour when Settings > Appearance asks for it
// (off by default: Devot's own palette). The generated tokens read
// `--system-accent-<role>-<appearance>` (role: fill, text, selection,
// selection-inactive or ring) and fall back to Devot's palette, so Multicolor, or
// the setting turned off, only needs the overrides removed.
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
const ROLES = ['fill', 'text', 'selection', 'selection-inactive', 'ring'] as const
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

/** Graphics, such as a focus ring, keep 3:1 on what they sit on (WCAG AA). */
export const GRAPHIC_CONTRAST = 3

/** What a focus ring can sit on: the surfaces. */
export function ringSurfaces(appearance: Appearance): Rgb[] {
  const theme = THEMES[appearance]
  return (['list', 'editor', 'sidebar-opaque', 'popover', 'float-bar'] as const).map(
    (name) => parseColor(theme[`color.surface.${name}`]).rgb,
  )
}

/**
 * How strongly a focus ring shows `fill`: `from` (the design strength), or
 * more, in 1% steps, until the ring keeps `GRAPHIC_CONTRAST` on every surface.
 */
export function ringAlpha(fill: Rgb, appearance: Appearance, from: number): number {
  const surfaces = ringSurfaces(appearance)
  for (let step = Math.round(from * 100); step <= 100; step++) {
    const alpha = step / 100
    const ring = { rgb: fill, alpha }
    if (surfaces.every((s) => contrastRatio(composite(ring, s), s) >= GRAPHIC_CONTRAST))
      return alpha
  }
  return 1
}

/** The contrast of the selection of an editor without focus: lighter, still seen. */
export const INACTIVE_SELECTION_CONTRAST = 1.15

/**
 * The editor selection for an accent fill: the fill mixed into the editor
 * surface, in 1% steps, until it stands `SELECTION_CONTRAST` from the editor
 * and, with the active line's tint over it (CodeMirror draws the selection in
 * a layer under the lines), from the active line. Solid, so it is the same
 * colour whatever it is drawn over. `inactive`, for an editor without focus,
 * is the lightest mix that stands `INACTIVE_SELECTION_CONTRAST` from both.
 */
export function selectionTints(fill: Rgb, appearance: Appearance): { focused: Rgb; inactive: Rgb } {
  const theme = THEMES[appearance]
  const editor = parseColor(theme['color.surface.editor']).rgb
  const line = parseColor(theme['color.editor.active-line'])
  const activeLine = composite(line, editor)
  const mix = (alpha: number) => composite({ rgb: fill, alpha }, editor).map(Math.round) as Rgb
  const lightest = (contrast: number): Rgb | undefined => {
    for (let step = 1; step <= 100; step++) {
      const tint = mix(step / 100)
      if (
        contrastRatio(tint, editor) >= contrast &&
        contrastRatio(composite(line, tint), activeLine) >= contrast
      )
        return tint
    }
    return undefined
  }
  const focused = lightest(SELECTION_CONTRAST) ?? fill
  return { focused, inactive: lightest(INACTIVE_SELECTION_CONTRAST) ?? focused }
}

/** The focused editor's selection for an accent fill (`selectionTints`). */
export const selectionTint = (fill: Rgb, appearance: Appearance): Rgb =>
  selectionTints(fill, appearance).focused

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
    composite(parseColor(theme['color.editor.active-line']), selection),
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
  const fillRgb = parseColor(fill).rgb
  const { focused: selection, inactive } = selectionTints(fillRgb, appearance)
  // Never fainter than the theme's own ring.
  const ownRing = parseColor(theme['color.focus.ring']).alpha
  return {
    fill,
    ring: toHex(fillRgb, ringAlpha(fillRgb, appearance, ownRing)),
    selection: toHex(selection),
    'selection-inactive': toHex(inactive),
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

/** No system accent: every role falls back to Devot's palette. */
const OWN_PALETTE: AccentInfo = { multicolor: true, light: null, dark: null }

/**
 * Applies the system accent while `wanted()` says so (Settings >
 * Appearance), Devot's palette otherwise, and keeps it in sync: call the
 * returned `refresh` when the setting changes.
 */
export async function followSystemAccent(
  style: StyleTarget,
  wanted: () => boolean,
): Promise<() => void> {
  let latest: AccentInfo | undefined
  const show = () => applyAccent(wanted() && latest ? latest : OWN_PALETTE, style)
  show()
  const { listen } = await import('@tauri-apps/api/event')
  await listen<AccentInfo>(ACCENT_EVENT, (event) => {
    latest = event.payload
    show()
  })
  const current = await invoke<AccentInfo>('system_accent')
  // An event that came in meanwhile is newer.
  latest ??= current
  show()
  return show
}
