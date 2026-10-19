// The system's Look Up and Speech for selected text (Rust: `text_look_up`,
// `text_speak`), used by the editor's and the preview's menus.
import { format, t } from './i18n'
import { invoke } from './ipc'
import type { MenuPoint } from './contextMenu'

/** The longest text Look Up takes (the same as Rust's). */
export const MAX_LOOK_UP_CHARS = 1000

/** The longest text Speech takes (the same as Rust's). */
export const MAX_SPEECH_CHARS = 100_000

const LABEL_CHARS = 24

/**
 * The selection a menu offers Look Up and Speech for: its text with white
 * space trimmed, or null when there is nothing. A very long one is cut
 * short (the most Speech takes).
 */
export function lookUpSelection(selected: string | null | undefined): string | null {
  const text = selected?.trim() ?? ''
  return text === '' ? null : Array.from(text).slice(0, MAX_SPEECH_CHARS).join('')
}

export function lookUpLabel(text: string): string {
  // The native menu refuses a label with a control character.
  const flat = text.replace(/[\s\p{Cc}]+/gu, ' ').trim()
  const chars = Array.from(flat)
  const shown =
    chars.length > LABEL_CHARS ? `${chars.slice(0, LABEL_CHARS).join('').trimEnd()}…` : flat
  return format(t('editorMenu.lookUp'), { text: shown })
}

export function leadingSpace(selected: string): number {
  return selected.length - selected.trimStart().length
}

/**
 * The point Look Up takes for a selection: the left edge of its first
 * character at the baseline (`bottom` of that character's box less the
 * font's descent). The dictionary draws its highlight of the word from that
 * point, and opens its popover under it.
 */
export function lookUpOrigin(start: { left: number; bottom: number }, descent: number): MenuPoint {
  return { x: start.left, y: start.bottom - Math.max(0, descent) }
}

export function fontDescent(style: CSSStyleDeclaration): number {
  const context = document.createElement('canvas').getContext('2d')
  if (context && style.font) {
    context.font = style.font
    const descent = context.measureText('x').fontBoundingBoxDescent
    if (Number.isFinite(descent) && descent > 0) return descent
  }
  return (parseFloat(style.fontSize) || 0) / 5
}

/**
 * The font the dictionary draws the word in, so its highlight covers the
 * text (Rust: `LookUpFont`): the CSS font list, the size in pixels, the
 * weight and whether it is italic.
 */
export interface LookUpFont {
  family: string
  size: number
  weight: number
  italic: boolean
}

export type FontStyle = Pick<
  CSSStyleDeclaration,
  'fontFamily' | 'fontSize' | 'fontWeight' | 'fontStyle'
>

/**
 * The Look Up font of a character's computed style; null when it has no
 * size or font list (Rust then uses the system font).
 */
export function lookUpFont(style: FontStyle): LookUpFont | null {
  const size = parseFloat(style.fontSize)
  if (!Number.isFinite(size) || size <= 0 || style.fontFamily.trim() === '') return null
  const weight = style.fontWeight === 'bold' ? 700 : parseFloat(style.fontWeight) || 400
  return {
    family: style.fontFamily,
    size,
    weight,
    italic: /^(italic|oblique)\b/.test(style.fontStyle),
  }
}

/**
 * Shows the system dictionary for `text` at a point in the window, the word
 * drawn in `font` (the system font without it); a failure is logged by code.
 */
export function lookUp(
  selection: string,
  at: MenuPoint,
  font: LookUpFont | null = null,
): Promise<void> {
  // The dictionary takes a word or a phrase; a point above or left of the
  // window (a caret scrolled out of sight) is clamped to its edge.
  const text = Array.from(selection).slice(0, MAX_LOOK_UP_CHARS).join('').trim()
  const x = Math.max(0, at.x)
  const y = Math.max(0, at.y)
  return invoke<void>('text_look_up', { text, x, y, font }).catch((error: unknown) =>
    console.warn('W_LOOK_UP_FAILED', error instanceof Error ? error.message : ''),
  )
}

export function startSpeaking(text: string | null): Promise<void> {
  return invoke<void>('text_speak', { action: 'start', text }).catch(() =>
    console.warn('W_SPEECH_FAILED'),
  )
}

export function stopSpeaking(): Promise<void> {
  return invoke<void>('text_speak', { action: 'stop', text: null }).catch(() =>
    console.warn('W_SPEECH_FAILED'),
  )
}
