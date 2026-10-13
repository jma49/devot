// Name fields stop at the core's limits (MAX_TAG_NAME_CHARS,
// MAX_BOOK_NAME_CHARS), counted in code points as the core and Rust count
// them; HTML's maxLength counts UTF-16 units, so an emoji would count twice.
// Like maxLength, an edit that would pass the limit keeps only what fits of
// the text it inserts. An input method's composition is left alone until it
// ends, then limited the same way.

import { useRef, type ChangeEvent, type CompositionEvent } from 'react'
import { charCount, clipChars, textDiff } from '../../core/text'

/**
 * `next` (the text after an edit of `previous`) within `max` code points,
 * and where the caret goes when the edit was cut (null: left as it is).
 */
export function limitEdit(
  previous: string,
  next: string,
  max: number,
): { value: string; caret: number | null } {
  if (charCount(next) <= max) return { value: next, caret: null }
  const { index, remove, insert } = textDiff(previous, next)
  const kept = charCount(previous) - charCount(previous.slice(index, index + remove))
  // Text already past the limit (it never should be) is cut at the end.
  if (kept > max) return { value: clipChars(next, max), caret: null }
  const fits = clipChars(insert, max - kept)
  return {
    value: previous.slice(0, index) + fits + previous.slice(index + remove),
    caret: index + fits.length,
  }
}

/** Limits the edit that turned `previous` into `field`'s text, in place; returns the text. */
function limitField(field: HTMLInputElement, previous: string, max: number): string {
  const { value, caret } = limitEdit(previous, field.value, max)
  if (value !== field.value) {
    field.value = value
    if (caret !== null) field.setSelectionRange(caret, caret)
  }
  return value
}

/**
 * Handlers for a controlled text field holding `value` that keep it within
 * `max` code points; `onValue` gets each value the field takes.
 */
export function useNameLimit(value: string, max: number, onValue: (value: string) => void) {
  // The text when a composition started; null while none runs.
  const before = useRef<string | null>(null)
  return {
    onCompositionStart: () => {
      before.current = value
    },
    onCompositionEnd: (e: CompositionEvent<HTMLInputElement>) => {
      const from = before.current ?? value
      before.current = null
      onValue(limitField(e.currentTarget, from, max))
    },
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      if (before.current !== null) onValue(e.currentTarget.value)
      else onValue(limitField(e.currentTarget, value, max))
    },
  }
}
