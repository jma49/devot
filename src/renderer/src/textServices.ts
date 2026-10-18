// The system's Look Up and Speech for selected text (Rust: `text_look_up`,
// `text_speak`), used by the editor's and the preview's menus.
import { format, t } from './i18n'
import { invoke } from './ipc'
import type { MenuPoint } from './contextMenu'

/** The longest text Look Up takes (the same as Rust's). */
export const MAX_LOOK_UP_CHARS = 1000

/** How many characters of the selection the Look Up item shows. */
const LABEL_CHARS = 24

/**
 * The text Look Up is asked for: the selection with its white space
 * trimmed, or null when there is nothing to look up. A longer selection is
 * cut short (the dictionary takes a word or a phrase).
 */
export function lookUpSelection(selected: string | null | undefined): string | null {
  const text = selected?.trim() ?? ''
  return text === '' ? null : Array.from(text).slice(0, MAX_LOOK_UP_CHARS).join('')
}

/** The Look Up item's text for a selection: `Look Up "text"`, the text cut short. */
export function lookUpLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ')
  const chars = Array.from(flat)
  const shown =
    chars.length > LABEL_CHARS ? `${chars.slice(0, LABEL_CHARS).join('').trimEnd()}…` : flat
  return format(t('editorMenu.lookUp'), { text: shown })
}

/** Shows the system dictionary for `text` at a point in the window; a failure is logged by code. */
export function lookUp(text: string, at: MenuPoint): Promise<void> {
  return invoke<void>('text_look_up', { text, x: at.x, y: at.y }).catch((error: unknown) =>
    console.warn('W_LOOK_UP_FAILED', error instanceof Error ? error.message : ''),
  )
}

/** Starts speaking the selection (the system speaks it; `text` is the fallback). */
export function startSpeaking(text: string | null): Promise<void> {
  return invoke<void>('text_speak', { action: 'start', text }).catch(() =>
    console.warn('W_SPEECH_FAILED'),
  )
}

/** Stops speaking. */
export function stopSpeaking(): Promise<void> {
  return invoke<void>('text_speak', { action: 'stop', text: null }).catch(() =>
    console.warn('W_SPEECH_FAILED'),
  )
}
