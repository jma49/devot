// Input methods (pinyin, kana, dead keys for accents) compose text before it
// is typed, and the keys they compose with are theirs: no field, window
// shortcut or editor key acts on them, or the Return that picks a candidate
// would also submit a field, and the Escape that cancels a composition would
// also close or clear one. `isImeKey` is the one check every key handler
// makes; the editor's keymaps get it from `editor/imeKeys.ts`.
//
// WebKit hands the page an input method's keys in three ways:
// - while a composition is open, with `isComposing` set;
// - with key code 229 when the input method took the key: the Return or
//   Escape that ends a composition arrives after `compositionend`, with
//   `isComposing` false;
// - now and then, as the first key down right after `compositionend` with
//   its own key code (the editor, CodeMirror, ignores that key as well).
// The last one needs `watchCompositions`, which each window's page starts.

/** How soon after a composition ends a key down still counts as the key that ended it. */
export const COMPOSITION_END_KEY_MS = 100

/** What the check reads of a key down (React's events carry it as `nativeEvent`). */
export interface KeyDownFields {
  readonly key: string
  readonly keyCode: number
  readonly isComposing: boolean
}

/** Key downs that came right after a composition ended (see `watchCompositions`). */
const endingKeys = new WeakSet<object>()

/**
 * Notes, on `target` (the window), each first key down that comes right after
 * a composition ended, before any handler of the page sees it. Returns a
 * function that stops watching.
 */
export function watchCompositions(
  target: EventTarget,
  now: () => number = () => performance.now(),
): () => void {
  let endedAt: number | undefined
  const ended = () => {
    endedAt = now()
  }
  const keyDown = (event: Event) => {
    if (endedAt !== undefined && now() - endedAt < COMPOSITION_END_KEY_MS) endingKeys.add(event)
    endedAt = undefined
  }
  target.addEventListener('compositionend', ended, true)
  target.addEventListener('keydown', keyDown, true)
  return () => {
    target.removeEventListener('compositionend', ended, true)
    target.removeEventListener('keydown', keyDown, true)
  }
}

/** Whether a key down belongs to an input method (see above), so nothing else may act on it. */
export function isImeKey(event: KeyDownFields): boolean {
  return (
    event.isComposing || event.keyCode === 229 || event.key === 'Process' || endingKeys.has(event)
  )
}

/**
 * Whether an input method is composing in the editor (`compositionStarted`
 * holds from compositionstart, before the composition changed any text).
 * Nothing may change the text then: it would end the composition and leave
 * the input method's raw text in the note.
 */
export function editorComposes(view: {
  readonly composing: boolean
  readonly compositionStarted: boolean
}): boolean {
  return view.composing || view.compositionStarted
}
