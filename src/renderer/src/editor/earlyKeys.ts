import { deleteCharBackward } from '@codemirror/commands'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { keyboardIsFree } from '../focus'
import { isImeKey } from '../ime'

/** A key typed before a field could take it: a character, or Enter, Backspace or Tab. */
export interface EarlyKey {
  readonly key: string
  readonly shift: boolean
}

const EDIT_KEYS = new Set(['Enter', 'Backspace', 'Tab'])

/** Collects the keys typed while nothing has the keyboard, until `stop` returns them. */
export function collectEarlyKeys(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  isFree: () => boolean,
): { stop: () => EarlyKey[] } {
  const typed: EarlyKey[] = []
  const onKey = (event: Event) => {
    const key = event as KeyboardEvent
    if (key.defaultPrevented || key.metaKey || key.ctrlKey || key.altKey) return
    if (key.key.length !== 1 && !EDIT_KEYS.has(key.key)) return
    if (isImeKey(key) || !isFree()) return
    key.preventDefault()
    if (key.key === 'Backspace' && !key.shiftKey && typed.at(-1)?.key.length === 1) typed.pop()
    else typed.push({ key: key.key, shift: key.shiftKey })
  }
  target.addEventListener('keydown', onKey)
  return {
    stop: () => {
      target.removeEventListener('keydown', onKey)
      return typed
    },
  }
}

export interface EarlyKeysEnv<F> {
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  isFree: () => boolean
  /** Takes the keyboard from the field that has it and returns that field. */
  leave: () => F | undefined
  canType: (field: F) => boolean
  /** Gives the keyboard back to `field` and types `keys` there when it can. */
  giveBack: (field: F, keys: readonly EarlyKey[]) => void
  waitMs: number
}

export interface EarlyKeysTicket {
  /** The keys are for the editor of this note. */
  claim: (noteId: string) => void
  /** The note was not made: the keys go back to the field they left. */
  fail: () => void
}

interface Session<F> {
  listening: { stop: () => EarlyKey[] } | undefined
  keys: EarlyKey[]
  noteId?: string
  field: F | undefined
  expiry: ReturnType<typeof setTimeout> | undefined
}

/**
 * From New Note until its editor opens, the note has no field to type into: what is typed then
 * is kept for that note's editor (`take`) instead of being lost. If the note is not made, or is
 * slow to be made, the keys go back to the field the user left.
 */
export function earlyKeys<F>(env: EarlyKeysEnv<F>) {
  let session: Session<F> | undefined

  const stopListening = (s: Session<F>) => {
    clearTimeout(s.expiry)
    if (!s.listening) return
    s.keys = s.listening.stop()
    s.listening = undefined
  }

  const end = (s: Session<F>) => {
    stopListening(s)
    if (session === s) session = undefined
    return s.keys
  }

  const expire = (s: Session<F>) => {
    stopListening(s)
    // A note already made keeps them for its editor, however late it opens.
    if (s.noteId !== undefined || s.field === undefined || !env.canType(s.field)) return
    env.giveBack(s.field, end(s))
  }

  return {
    start(): EarlyKeysTicket {
      const before = session
      if (before) {
        expire(before)
        if (session === before) session = undefined
      }
      const s: Session<F> = {
        listening: collectEarlyKeys(env.target, env.isFree),
        keys: [],
        field: env.leave() ?? before?.field,
        expiry: undefined,
      }
      s.expiry = setTimeout(() => expire(s), env.waitMs)
      session = s
      return {
        claim: (noteId) => {
          if (session === s) s.noteId = noteId
        },
        fail: () => {
          if (session !== s) return
          const keys = end(s)
          if (s.field !== undefined) env.giveBack(s.field, keys)
        },
      }
    },

    take(noteId: string): EarlyKey[] {
      return session?.noteId === noteId ? end(session) : []
    },

    /** Keys are being kept for another note, so this one must not take the keyboard. */
    keptForAnother(noteId: string): boolean {
      return session?.listening !== undefined && session.noteId !== noteId
    },
  }
}

/** Types `keys` into the editor as if they had been pressed there. */
export function replayEarlyKeys(view: EditorView, keys: readonly EarlyKey[]): void {
  let text = ''
  const flush = () => {
    if (text) view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.type' })
    text = ''
  }
  for (const { key, shift } of keys) {
    if (key.length === 1) {
      text += key
      continue
    }
    flush()
    const event = new KeyboardEvent('keydown', { key, shiftKey: shift, cancelable: true })
    if (runScopeHandlers(view, event, 'editor')) continue
    if (key === 'Backspace') deleteCharBackward(view)
    else text += key === 'Enter' ? '\n' : '\t'
  }
  flush()
}

type TextField = HTMLInputElement | HTMLTextAreaElement

const isTextField = (field: Element): field is TextField =>
  field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement

function canTypeIn(field: HTMLElement): boolean {
  if (!field.isConnected) return false
  if (isTextField(field)) return !field.readOnly && !field.disabled
  return field.isContentEditable
}

function typeInto(field: TextField, keys: readonly EarlyKey[]) {
  for (const { key } of keys) {
    const start = field.selectionStart ?? field.value.length
    const end = field.selectionEnd ?? start
    if (key !== 'Backspace') {
      field.setRangeText(key === 'Enter' ? '\n' : key === 'Tab' ? '\t' : key, start, end, 'end')
    } else if (start !== end || start > 0) {
      field.setRangeText('', start === end ? start - 1 : start, end, 'end')
    }
  }
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

function giveBackTo(field: HTMLElement, keys: readonly EarlyKey[]) {
  if (!field.isConnected) return
  // Focusing a text field again may select all of it: the caret goes back where it was.
  const caret = isTextField(field) ? [field.selectionStart, field.selectionEnd] : []
  field.focus()
  const typing = keys.length > 0 && canTypeIn(field)
  const view = EditorView.findFromDOM(field)
  if (view) {
    if (typing) replayEarlyKeys(view, keys)
    return
  }
  if (!isTextField(field)) return
  const [start, end] = caret
  // Inputs without text selection (email, number) cannot take text this way.
  try {
    if (start != null && end != null) field.setSelectionRange(start, end)
    if (typing) typeInto(field, keys)
  } catch {
    console.warn('W_EARLY_KEYS_LOST')
  }
}

let windowKeys: ReturnType<typeof earlyKeys<HTMLElement>> | undefined

const forWindow = () =>
  (windowKeys ??= earlyKeys<HTMLElement>({
    target: window,
    isFree: keyboardIsFree,
    leave: () => {
      const active = document.activeElement
      if (!(active instanceof HTMLElement) || active === document.body) return undefined
      active.blur()
      return active
    },
    canType: canTypeIn,
    giveBack: giveBackTo,
    waitMs: 3000,
  }))

export const startEarlyKeys = (): EarlyKeysTicket => forWindow().start()

export const takeEarlyKeys = (noteId: string): EarlyKey[] => windowKeys?.take(noteId) ?? []

export const earlyKeysKeptForAnother = (noteId: string): boolean =>
  windowKeys?.keptForAnother(noteId) ?? false
