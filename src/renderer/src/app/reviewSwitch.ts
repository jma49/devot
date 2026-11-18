import type { Mode } from '../ModeControl'

/** The editor mode Review Changes switched to from Preview; `shown` once that mode took effect. */
export type ReviewSwitch = { noteId: string; switchedTo: Mode; shown: boolean }

/**
 * Follows the switch as the note, its unseen changes and the mode move on: it puts Preview back
 * when the last change is reviewed in the switched-to mode, and is forgotten once the owner
 * leaves that mode by hand, so a later mode change is never undone.
 */
export function followReviewSwitch(
  switched: ReviewSwitch | undefined,
  now: { noteId: string | undefined; unseen: number; mode: Mode },
): { next: ReviewSwitch | undefined; toPreview: boolean } {
  const forget = { next: undefined, toPreview: false }
  if (!switched || now.noteId !== switched.noteId) return forget
  if (now.mode === switched.switchedTo) {
    if (now.unseen === 0) return { next: undefined, toPreview: true }
    return { next: switched.shown ? switched : { ...switched, shown: true }, toPreview: false }
  }
  if (now.mode === 'preview' && !switched.shown && now.unseen > 0) {
    return { next: switched, toPreview: false }
  }
  return forget
}
