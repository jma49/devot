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

export const COMPOSITION_END_KEY_MS = 100

export interface KeyDownFields {
  readonly key: string
  readonly keyCode: number
  readonly isComposing: boolean
}

const endingKeys = new WeakSet<object>()

/** Marks each first key down right after a composition ended, before any page handler sees it. Returns a function that stops watching. */
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
  // The capture flag goes in an options object: with a bare `true`,
  // removeEventListener on Node 24's EventTarget does not find the listener,
  // and a stopped watch would go on running.
  const capture = { capture: true }
  target.addEventListener('compositionend', ended, capture)
  target.addEventListener('keydown', keyDown, capture)
  return () => {
    target.removeEventListener('compositionend', ended, capture)
    target.removeEventListener('keydown', keyDown, capture)
  }
}

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
