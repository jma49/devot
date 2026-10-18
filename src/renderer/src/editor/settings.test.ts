import { getIndentUnit } from '@codemirror/language'
import {
  cursorCharLeft,
  moveLineUp,
  indentLess,
  indentMore,
  insertBlankLine,
  redoSelection,
  toggleBlockComment,
} from '@codemirror/commands'
import { foldCode } from '@codemirror/language'
import {
  findNext,
  findPrevious,
  gotoLine,
  openSearchPanel,
  replaceAll,
  replaceNext,
  selectNextOccurrence,
  selectSelectionMatches,
} from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, type Command } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from '../../../core/editorSettings'
import { shortcutCodeMirror } from '../commands/keys'
import { COMMANDS, setCommandKeys } from '../commands/registry'
import { listBullet } from './blocks'
import { inlineImageField } from './images'
import { pasteUrlStyle } from './paste'
import { toolbarOff } from './toolbarState'
import { codeMirrorKey, editorSetup, reconfigureSetup } from './settings'
import { keepCaretLine, unwrapMode } from './unwrap'

const make = (settings: EditorSettings) =>
  EditorState.create({ doc: 'a', extensions: editorSetup(settings) })

const attrs = (state: EditorState) =>
  Object.assign(
    {},
    ...state.facet(EditorView.contentAttributes).filter((a) => typeof a === 'object'),
  )

describe('editor setup from the settings', () => {
  it('wraps lines as the line wrapping mode says', () => {
    const wrapClass = (state: EditorState) =>
      state
        .facet(EditorView.contentAttributes)
        .some((a) => typeof a === 'object' && /cm-lineWrapping/.test(a['class'] ?? ''))
    const mode = (lineWrapping: EditorSettings['lineWrapping']) =>
      make({ ...DEFAULT_EDITOR_SETTINGS, lineWrapping })
    expect(wrapClass(mode('off'))).toBe(false)
    expect(mode('off').facet(unwrapMode)).toBeNull()
    expect(wrapClass(mode('all'))).toBe(true)
    expect(mode('all').facet(unwrapMode)).toBeNull()
    expect(wrapClass(mode('prose'))).toBe(true)
    expect(mode('prose').facet(unwrapMode)).toBe('all')
    expect(wrapClass(mode('unwrapAtCursor'))).toBe(true)
    expect(mode('unwrapAtCursor').facet(unwrapMode)).toBe('active')
    // The default unwraps the block under the caret.
    expect(make(DEFAULT_EDITOR_SETTINGS).facet(unwrapMode)).toBe('active')
  })

  it('keeps lines to the reading width in any wrapping mode but off', () => {
    const css = (state: EditorState) =>
      JSON.stringify(state.facet(EditorView.styleModule).map((m) => Object.values(m)))
    for (const lineWrapping of ['all', 'prose', 'unwrapAtCursor'] as const)
      expect(
        css(make({ ...DEFAULT_EDITOR_SETTINGS, lineWrapping, readableWidth: true })),
      ).toContain('--size-reading-width')
    expect(
      css(make({ ...DEFAULT_EDITOR_SETTINGS, lineWrapping: 'off', readableWidth: true })),
    ).not.toContain('--size-reading-width')
  })

  it('scrolls unwrapped blocks sideways inside the reading column', () => {
    const css = (state: EditorState) =>
      JSON.stringify(state.facet(EditorView.styleModule).map((m) => Object.values(m)))
    for (const lineWrapping of ['prose', 'unwrapAtCursor'] as const)
      expect(
        css(make({ ...DEFAULT_EDITOR_SETTINGS, lineWrapping, readableWidth: true })),
      ).toContain('overflow-x')
    // Nothing unwraps in the other modes, and without the reading width the editor scrolls.
    expect(
      css(make({ ...DEFAULT_EDITOR_SETTINGS, lineWrapping: 'all', readableWidth: true })),
    ).not.toContain('overflow-x')
    expect(
      css(make({ ...DEFAULT_EDITOR_SETTINGS, lineWrapping: 'prose', readableWidth: false })),
    ).not.toContain('overflow-x')
  })

  it('keeps the caret line in place when the wrapping mode changes', () => {
    const effects = reconfigureSetup(DEFAULT_EDITOR_SETTINGS, {
      ...DEFAULT_EDITOR_SETTINGS,
      lineWrapping: 'prose',
    })
    expect(effects.some((e) => e.is(keepCaretLine))).toBe(true)
    const after = make(DEFAULT_EDITOR_SETTINGS).update({ effects }).state
    expect(after.facet(unwrapMode)).toBe('all')
    // The wrapping part and the reading width part (which reads the mode too).
    expect(effects.filter((e) => !e.is(keepCaretLine))).toHaveLength(2)
    expect(
      reconfigureSetup(DEFAULT_EDITOR_SETTINGS, { ...DEFAULT_EDITOR_SETTINGS, fontSize: 14 }).some(
        (e) => e.is(keepCaretLine),
      ),
    ).toBe(false)
  })

  it('sets the indent unit, the tab width, the bullet and spell checking', () => {
    const state = make({
      ...DEFAULT_EDITOR_SETTINGS,
      indentUnit: 'tab',
      tabWidth: 8,
      listMarker: '+',
      spellCheck: false,
    })
    expect(state.facet(EditorState.tabSize)).toBe(8)
    expect(getIndentUnit(state)).toBe(8)
    expect(state.facet(listBullet)).toBe('+')
    expect(attrs(state)).not.toHaveProperty('spellcheck')

    const plain = make(DEFAULT_EDITOR_SETTINGS)
    expect(plain.facet(EditorState.tabSize)).toBe(2)
    expect(getIndentUnit(plain)).toBe(2)
    expect(plain.facet(listBullet)).toBe('*')
    expect(attrs(plain)).toMatchObject({ spellcheck: 'true' })
  })

  it('maps each new flag to its extension', () => {
    const on = make(DEFAULT_EDITOR_SETTINGS)
    expect(on.facet(toolbarOff)).toBe(false)
    expect(make({ ...DEFAULT_EDITOR_SETTINGS, toolbar: false }).facet(toolbarOff)).toBe(true)
    // Scroll past end is on by default and pads under the last line.
    const css = (state: EditorState) =>
      JSON.stringify(state.facet(EditorView.styleModule).map((m) => Object.values(m)))
    expect(css(on)).toContain('50vh')
    expect(css(make({ ...DEFAULT_EDITOR_SETTINGS, scrollPastEnd: false }))).not.toContain('50vh')
    // The cursor scroll margin is a scroll margin on both edges, none at 0.
    const margins = (state: EditorState) =>
      state.facet(EditorView.scrollMargins).map((f) => f({} as EditorView))
    // With Scroll Past End the caret keeps four lines of room below it (13px at 1.5).
    expect(margins(on)).toEqual([{ top: 0, bottom: 78 }])
    expect(margins(make({ ...DEFAULT_EDITOR_SETTINGS, scrollPastEnd: false }))).toEqual([])
    expect(margins(make({ ...DEFAULT_EDITOR_SETTINGS, cursorScrollMargin: 40 }))).toEqual([
      { top: 40, bottom: 78 },
    ])
    expect(
      margins(make({ ...DEFAULT_EDITOR_SETTINGS, cursorScrollMargin: 120, scrollPastEnd: false })),
    ).toEqual([{ top: 120, bottom: 120 }])
    // Drawn whitespace and tinted trailing whitespace are decorations of their own.
    const decorated = (settings: EditorSettings) =>
      make(settings).facet(EditorView.decorations).length
    const base = decorated(DEFAULT_EDITOR_SETTINGS)
    expect(decorated({ ...DEFAULT_EDITOR_SETTINGS, showInvisibles: true })).toBe(base + 1)
    expect(decorated({ ...DEFAULT_EDITOR_SETTINGS, highlightTrailingWhitespace: true })).toBe(
      base + 1,
    )
    // Each flag reconfigures only its own part.
    for (const key of ['toolbar', 'showInvisibles', 'highlightTrailingWhitespace'] as const) {
      expect(
        reconfigureSetup(DEFAULT_EDITOR_SETTINGS, {
          ...DEFAULT_EDITOR_SETTINGS,
          [key]: !DEFAULT_EDITOR_SETTINGS[key],
        }),
      ).toHaveLength(1)
    }
    // Scroll Past End also sets the room under the caret.
    expect(
      reconfigureSetup(DEFAULT_EDITOR_SETTINGS, {
        ...DEFAULT_EDITOR_SETTINGS,
        scrollPastEnd: false,
      }),
    ).toHaveLength(2)
    expect(
      reconfigureSetup(DEFAULT_EDITOR_SETTINGS, {
        ...DEFAULT_EDITOR_SETTINGS,
        cursorScrollMargin: 8,
      }),
    ).toHaveLength(1)
  })

  it('gives the editor the way a lone URL is pasted', () => {
    expect(make(DEFAULT_EDITOR_SETTINGS).facet(pasteUrlStyle)).toBe('link')
    const plain = make({ ...DEFAULT_EDITOR_SETTINGS, pasteUrl: 'plain' })
    expect(plain.facet(pasteUrlStyle)).toBe('plain')
    const effects = reconfigureSetup(DEFAULT_EDITOR_SETTINGS, {
      ...DEFAULT_EDITOR_SETTINGS,
      pasteUrl: 'autolink',
    })
    expect(effects).toHaveLength(1)
    expect(make(DEFAULT_EDITOR_SETTINGS).update({ effects }).state.facet(pasteUrlStyle)).toBe(
      'autolink',
    )
  })

  it('shows images under their lines only while the setting is on', () => {
    expect(make(DEFAULT_EDITOR_SETTINGS).field(inlineImageField, false)).toBeDefined()
    const off = make({ ...DEFAULT_EDITOR_SETTINGS, inlineImages: false })
    expect(off.field(inlineImageField, false)).toBeUndefined()
    const effects = reconfigureSetup(
      { ...DEFAULT_EDITOR_SETTINGS, inlineImages: false },
      DEFAULT_EDITOR_SETTINGS,
    )
    expect(effects).toHaveLength(1)
    expect(off.update({ effects }).state.field(inlineImageField, false)).toBeDefined()
  })

  it('reconfigures only what changed, keeping the document and selection', () => {
    expect(reconfigureSetup(DEFAULT_EDITOR_SETTINGS, { ...DEFAULT_EDITOR_SETTINGS })).toEqual([])
    const before = make(DEFAULT_EDITOR_SETTINGS).update({ selection: { anchor: 1 } }).state
    const to: EditorSettings = {
      ...DEFAULT_EDITOR_SETTINGS,
      indentUnit: 'spaces4',
      listMarker: '-',
      spellCheck: false,
    }
    const effects = reconfigureSetup(DEFAULT_EDITOR_SETTINGS, to)
    expect(effects).toHaveLength(3)
    const after = before.update({ effects }).state
    expect(getIndentUnit(after)).toBe(4)
    expect(after.facet(listBullet)).toBe('-')
    expect(attrs(after)).not.toHaveProperty('spellcheck')
    expect(after.doc.toString()).toBe('a')
    expect(after.selection.main.head).toBe(1)
    // The gutter follows both line numbers and the current-line highlight.
    expect(
      reconfigureSetup(DEFAULT_EDITOR_SETTINGS, {
        ...DEFAULT_EDITOR_SETTINGS,
        highlightActiveLine: true,
      }),
    ).toHaveLength(2)
  })
})

describe('the editor keymap', () => {
  const bindings = () => make(DEFAULT_EDITOR_SETTINGS).facet(keymap).flat()

  it('leaves every window key to the window, such as the palette, the sidebar and the next note', () => {
    const keys = bindings().flatMap((b) => [b.key, b.mac])
    const window = COMMANDS.flatMap((c) =>
      c.scope === 'window' ? c.keys.map(shortcutCodeMirror) : [],
    )
    expect(window).toEqual(
      expect.arrayContaining(['Mod-k', 'Mod-p', 'Shift-Mod-]', 'Mod-/', 'Mod-[', 'Mod-]']),
    )
    // An arrow key stays the editor's: Cmd+Left and Cmd+Right move the caret
    // (Back and Forward take them only outside text fields).
    const moving = window.filter((key) => /(^|-)Arrow/.test(key))
    expect(moving).toEqual(['Mod-ArrowLeft', 'Mod-ArrowRight'])
    expect(
      keys.filter((key) => key !== undefined && window.includes(key) && !moving.includes(key)),
    ).toEqual([])
  })

  it('indents with Tab and outdents with Shift+Tab', () => {
    const tab = bindings().filter((b) => b.key === 'Tab')
    expect(tab).toEqual([expect.objectContaining({ run: indentMore, shift: indentLess })])
  })
})

describe('CodeMirror bindings under keys the user set', () => {
  afterEach(() => setCommandKeys(undefined))
  // As CodeMirror decides: Mod is Command on macOS, Control elsewhere.
  const mac = /Mac/.test(globalThis.navigator?.platform ?? '')
  const mod = mac ? 'Mod' : 'Ctrl'
  /** The built-in bindings with these keys in effect (the rest their defaults). */
  const withKeys = (keys: Record<string, string[]>) => {
    setCommandKeys(new Map(COMMANDS.map((c) => [c.id, keys[c.id] ?? c.keys])))
    return make(DEFAULT_EDITOR_SETTINGS).facet(keymap).flat()
  }
  const runs = (bindings: ReturnType<typeof withKeys>, command: Command) =>
    bindings.some((b) => b.run === command || b.shift === command)

  it('gives an editor command a key CodeMirror binds, such as Paste as Plain Text', () => {
    const before = withKeys({})
    for (const command of [moveLineUp, selectNextOccurrence, insertBlankLine])
      expect(runs(before, command)).toBe(true)
    expect(runs(withKeys({ 'edit.pastePlain': ['Alt+ArrowUp'] }), moveLineUp)).toBe(false)
    expect(runs(withKeys({ 'edit.pastePlain': [`${mod}+D`] }), selectNextOccurrence)).toBe(false)
    expect(runs(withKeys({ 'edit.pastePlain': [`${mod}+Enter`] }), insertBlankLine)).toBe(false)
  })

  it("has no key that opens one of CodeMirror's panels, whatever keys the user gave", () => {
    // Devot has its own find bar (find.ts); Go to Line's dialog and the
    // search panel are unthemed and not in the message catalog. Find Next
    // moved off Cmd+G is the key CodeMirror's own Find Next would take.
    const panels = [openSearchPanel, findNext, findPrevious, replaceNext, replaceAll, gotoLine]
    for (const keys of [{}, { 'find.next': ['Mod+Shift+J'], 'find.previous': ['Mod+Shift+K'] }]) {
      const bindings = withKeys(keys)
      for (const command of panels) expect(runs(bindings, command)).toBe(false)
    }
    // The searches that open nothing stay.
    const bindings = withKeys({})
    expect(runs(bindings, selectNextOccurrence)).toBe(true)
    expect(runs(bindings, selectSelectionMatches)).toBe(true)
  })

  it('keeps CodeMirror bindings under an editor command default key (Tab in a table)', () => {
    const tab = withKeys({}).filter((b) => b.key === 'Tab')
    expect(tab).toEqual([expect.objectContaining({ run: indentMore, shift: indentLess })])
  })

  it('compares keys however CodeMirror spells them', () => {
    // Cmd-Alt-[ (fold, on macOS), Mod-Shift-l, Mod-Shift-u (macOS) and Ctrl-A
    // (Control+Shift+A, on macOS) are the same keys as these window keys.
    expect(runs(withKeys({ 'note.next': [`${mod}+Shift+L`] }), selectSelectionMatches)).toBe(false)
    if (!mac) return
    expect(runs(withKeys({ 'note.next': ['Mod+Alt+['] }), foldCode)).toBe(false)
    expect(runs(withKeys({ 'note.next': ['Mod+Shift+U'] }), redoSelection)).toBe(false)
    expect(runs(withKeys({ 'note.next': ['Ctrl+Shift+A'] }), toggleBlockComment)).toBe(false)
  })

  it('takes only the Shift variant of a binding when only that key is in use', () => {
    if (!mac) return
    // Control+B moves the cursor on macOS; Control+Shift+B selects.
    const bindings = withKeys({ 'note.next': ['Ctrl+Shift+B'] })
    const ctrlB = bindings.filter((b) => b.run === cursorCharLeft && b.mac === 'Ctrl-b')
    expect(ctrlB).toHaveLength(1)
    expect(ctrlB[0]?.shift).toBeUndefined()
  })
})

describe('codeMirrorKey', () => {
  it('writes every spelling of a key one way, for the platform', () => {
    for (const name of ['Cmd-Alt-[', 'Mod-Alt-[', 'Alt-Mod-[', 'Meta-a-['])
      expect(codeMirrorKey(name, true)).toBe('Alt-Meta-[')
    expect(codeMirrorKey('Mod-Alt-[', false)).toBe('Ctrl-Alt-[')
    expect(codeMirrorKey('Ctrl-A', true)).toBe('Shift-Ctrl-a')
    expect(codeMirrorKey('Shift-Control-a', true)).toBe('Shift-Ctrl-a')
    expect(codeMirrorKey('Mod-Shift-l', true)).toBe(codeMirrorKey('Shift-Mod-l', true))
    expect(codeMirrorKey('Mod--', true)).toBe('Meta--')
    expect(codeMirrorKey('Mod-Space', false)).toBe('Ctrl- ')
  })
})
