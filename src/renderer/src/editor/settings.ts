// The note editor's setup, with the parts the editor settings control in
// compartments: a change reconfigures the open editor (one transaction, no
// rebuild), so its text, selection, undo history and focus stay. Font, size
// and line height are CSS variables instead (see editorSettings.ts).
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from '@codemirror/language'
import {
  highlightSelectionMatches,
  searchKeymap,
  selectNextOccurrence,
  selectSelectionMatches,
} from '@codemirror/search'
import { Compartment, EditorState, type Extension, type StateEffect } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  highlightWhitespace,
  keymap,
  lineNumbers,
  type KeyBinding,
  rectangularSelection,
} from '@codemirror/view'
import { indentText, type EditorSettings } from '../../../core/editorSettings'
import { shortcutCodeMirror } from '../commands/keys'
import { COMMANDS, commandKeys, defaultKeys } from '../commands/registry'
import { listBullet } from './blocks'
import { inlineImages } from './images'
import { pasteUrlStyle } from './paste'
import { registryKeys } from './registryKeys'
import { toolbarOff } from './toolbarState'
import { keepCaretInColumn, keepCaretLine, wrappingModes } from './unwrap'

const MAC =
  typeof navigator !== 'undefined' &&
  (/Mac/.test(navigator.platform) || /iP(hone|ad|od)/.test(navigator.platform))

/**
 * The key press a CodeMirror key name means, written one way: modifiers in
 * the order Shift, Ctrl, Alt, Meta, then the key, with `Mod` resolved for
 * the platform and an upper-case letter read as Shift and that letter (as
 * CodeMirror matches it). `Cmd-Alt-[`, `Mod-Alt-[` and `Alt-Mod-[` are the
 * same key on macOS; so are `Ctrl-A` and `Shift-Ctrl-a`.
 */
export function codeMirrorKey(name: string, mac: boolean = MAC): string {
  const parts = name.split(/-(?!$)/)
  let key = parts.pop() ?? ''
  const mods = new Set<string>()
  for (const part of parts) {
    if (/^(cmd|meta|m)$/i.test(part)) mods.add('Meta')
    else if (/^a(lt)?$/i.test(part)) mods.add('Alt')
    else if (/^(c|ctrl|control)$/i.test(part)) mods.add('Ctrl')
    else if (/^s(hift)?$/i.test(part)) mods.add('Shift')
    else if (/^mod$/i.test(part)) mods.add(mac ? 'Meta' : 'Ctrl')
    else mods.add(part)
  }
  if (key === 'Space') key = ' '
  if (/^[A-Z]$/.test(key)) {
    mods.add('Shift')
    key = key.toLowerCase()
  }
  return [...['Shift', 'Ctrl', 'Alt', 'Meta'].filter((m) => mods.has(m)), key].join('-')
}

/**
 * Keys a command of Devot's takes in the editor, as `codeMirrorKey` writes
 * them: every key in effect of a window command (Back and Forward on Cmd+[
 * and Cmd+], the sidebar on Cmd+/, ...) but an arrow key, which moves the
 * caret in text (dispatch.ts leaves it alone there), and every key of an
 * editor command other than its defaults (a default such as Tab in a table
 * falls through to CodeMirror's binding when the command does not apply).
 */
const takenKeys = () =>
  new Set(
    COMMANDS.flatMap((c) => {
      const keys =
        c.scope === 'window'
          ? commandKeys(c.id).filter((key) => !/(^|\+)Arrow/.test(key))
          : c.scope === 'editor'
            ? commandKeys(c.id).filter((key) => !defaultKeys(c.id).includes(key))
            : []
      return keys.map((key) => codeMirrorKey(shortcutCodeMirror(key)))
    }),
  )

/**
 * CodeMirror's own bindings, less those on a key a command takes (indent
 * and outdent on Cmd+[ and Cmd+], toggle comment on Cmd+/, delete line on a
 * key the user gave Paste as Plain Text), so that key reaches the command.
 * A binding's Shift variant (`shift`) is taken off on its own. Keys are
 * compared as presses, not as names, and by the name CodeMirror uses on
 * this platform (`mac` on macOS, else `key`).
 */
const withoutTakenKeys = (bindings: readonly KeyBinding[]): KeyBinding[] => {
  const taken = takenKeys()
  return bindings.flatMap((b): KeyBinding[] => {
    const name = (MAC ? b.mac : undefined) ?? b.key
    if (name === undefined) return [b]
    const plain = taken.has(codeMirrorKey(name))
    const shifted = b.shift !== undefined && taken.has(codeMirrorKey(`Shift-${name}`))
    if (!plain && !shifted) return [b]
    const { shift, ...unshifted } = b
    if (!plain) return [unshifted]
    if (shift === undefined || shifted) return []
    const alone: KeyBinding = { key: `Shift-${name}`, run: shift }
    if (b.preventDefault) alone.preventDefault = true
    if (b.stopPropagation) alone.stopPropagation = true
    if (b.scope !== undefined) alone.scope = b.scope
    return [alone]
  })
}

/**
 * CodeMirror's search keys that open nothing. The rest open its search panel
 * or its Go to Line dialog, which are unthemed and not in the message
 * catalog; the only find UI is Devot's own (find.ts), and a key freed by
 * rebinding Find Next must not bring the panel back.
 */
const searchKeysWithoutPanels = searchKeymap.filter(
  (b) => b.run === selectNextOccurrence || b.run === selectSelectionMatches,
)

const builtInKeys = registryKeys(() =>
  keymap.of(
    withoutTakenKeys([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      // Indenting moves to Tab and Shift+Tab (a table's keys come first:
      // there they move between cells); Control+Tab, or Escape then Tab,
      // leaves the editor.
      indentWithTab,
      ...searchKeysWithoutPanels,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
    ]),
  ),
)

const fixedSetup: Extension = [
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightSelectionMatches(),
]

// Made once, so reconfiguring with an unchanged value changes nothing.
const gutterOn = [lineNumbers(), foldGutter()]
const activeLineGutter = highlightActiveLineGutter()
const activeLine = highlightActiveLine()
const spellCheck = EditorView.contentAttributes.of({ spellcheck: 'true' })
/**
 * Lines no wider than the reading width, in the middle of the editor. The
 * split view sets `--editor-reading-width` to `none` (app.css): there each
 * pane takes half the note area.
 */
const readableWidth = EditorView.theme({
  '.cm-content': {
    maxWidth: 'var(--editor-reading-width, var(--size-reading-width))',
    marginInline: 'auto',
  },
})

/**
 * With blocks that do not wrap, the reading column scrolls sideways itself:
 * a long code or table line stays inside the column, whose edge stays straight.
 */
const readableWidthScroll = EditorView.theme({
  '.cm-content': { overflowX: 'auto' },
})

const pastEnd = EditorView.theme({ '&.cm-editor .cm-content': { paddingBottom: '50vh' } })
const LAST_LINE_ROOM = 4

/**
 * The pixels kept above and below the caret when it scrolls into view: the
 * setting, and with Scroll Past End a few lines below it, so the last line
 * scrolls up from the bottom of the window.
 */
export function scrollMarginsOf(s: EditorSettings): { top: number; bottom: number } {
  const room = s.scrollPastEnd ? Math.round(s.fontSize * s.lineHeight * LAST_LINE_ROOM) : 0
  return { top: s.cursorScrollMargin, bottom: Math.max(s.cursorScrollMargin, room) }
}

/** Room the trial-ended bar keeps at the foot of the window (TrialNotices.tsx), read when the margin is. */
function trialBarInset(): number {
  if (typeof document === 'undefined') return 0
  const px = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--trial-bar-inset'),
  )
  return Number.isFinite(px) ? px : 0
}
const whitespaceTheme = EditorView.theme({
  '.cm-highlightSpace': {
    backgroundImage:
      'radial-gradient(circle at 50% 55%, var(--color-text-tertiary) 20%, transparent 5%)',
  },
  '.cm-trailingSpace': { backgroundColor: 'var(--color-trailing-space)' },
})
const trailingWhitespace = [highlightTrailingWhitespace(), whitespaceTheme]
const invisibles = [highlightWhitespace(), whitespaceTheme]

const PARTS = {
  gutter: (s: EditorSettings): Extension =>
    s.lineNumbers ? [gutterOn, s.highlightActiveLine ? activeLineGutter : []] : [],
  activeLine: (s: EditorSettings): Extension => (s.highlightActiveLine ? activeLine : []),
  wrapping: (s: EditorSettings): Extension => wrappingModes[s.lineWrapping],
  // Only wrapped lines can keep to a width; an unwrapped block scrolls inside it.
  width: (s: EditorSettings): Extension => {
    if (!s.readableWidth || s.lineWrapping === 'off') return []
    return s.lineWrapping === 'all'
      ? readableWidth
      : [readableWidth, readableWidthScroll, keepCaretInColumn]
  },
  indent: (s: EditorSettings): Extension => [
    indentUnit.of(indentText(s.indentUnit)),
    EditorState.tabSize.of(s.tabWidth),
  ],
  spelling: (s: EditorSettings): Extension => (s.spellCheck ? spellCheck : []),
  bullet: (s: EditorSettings): Extension => listBullet.of(s.listMarker),
  pasteUrl: (s: EditorSettings): Extension => pasteUrlStyle.of(s.pasteUrl),
  images: (s: EditorSettings): Extension => (s.inlineImages ? inlineImages : []),
  toolbar: (s: EditorSettings): Extension => (s.toolbar ? [] : toolbarOff.of(true)),
  scrollPastEnd: (s: EditorSettings): Extension => (s.scrollPastEnd ? pastEnd : []),
  scrollMargin: (s: EditorSettings): Extension => {
    const { top, bottom } = scrollMarginsOf(s)
    return top > 0 || bottom > 0
      ? EditorView.scrollMargins.of(() => ({ top, bottom: bottom + trialBarInset() }))
      : []
  },
  invisibles: (s: EditorSettings): Extension => (s.showInvisibles ? invisibles : []),
  trailing: (s: EditorSettings): Extension =>
    s.highlightTrailingWhitespace ? trailingWhitespace : [],
} as const

type Part = keyof typeof PARTS

const READS: Readonly<Record<Part, readonly (keyof EditorSettings)[]>> = {
  gutter: ['lineNumbers', 'highlightActiveLine'],
  activeLine: ['highlightActiveLine'],
  wrapping: ['lineWrapping'],
  width: ['readableWidth', 'lineWrapping'],
  indent: ['indentUnit', 'tabWidth'],
  spelling: ['spellCheck'],
  bullet: ['listMarker'],
  pasteUrl: ['pasteUrl'],
  images: ['inlineImages'],
  toolbar: ['toolbar'],
  scrollPastEnd: ['scrollPastEnd'],
  scrollMargin: ['cursorScrollMargin', 'scrollPastEnd', 'fontSize', 'lineHeight'],
  invisibles: ['showInvisibles'],
  trailing: ['highlightTrailingWhitespace'],
}

const NAMES = Object.keys(PARTS) as Part[]
const compartments = Object.fromEntries(NAMES.map((n) => [n, new Compartment()])) as Record<
  Part,
  Compartment
>

export function editorSetup(settings: EditorSettings): Extension {
  return [NAMES.map((n) => compartments[n].of(PARTS[n](settings))), fixedSetup, builtInKeys()]
}

/**
 * The effects that take an editor set up for `from` to `to`. A new line
 * wrapping mode also keeps the caret's line where it is on screen.
 */
export function reconfigureSetup(from: EditorSettings, to: EditorSettings): StateEffect<unknown>[] {
  const effects: StateEffect<unknown>[] = NAMES.filter((n) =>
    READS[n].some((key) => from[key] !== to[key]),
  ).map((n) => compartments[n].reconfigure(PARTS[n](to)))
  if (from.lineWrapping !== to.lineWrapping) effects.push(keepCaretLine.of(null))
  return effects
}
