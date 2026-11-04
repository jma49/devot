import { LanguageDescription, ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { beforeAll, describe, it } from 'vitest'
import { expectWithinBudget } from '../../../../tests/support/budget'
import { blockDecorations, codeBlocks } from './codeBlocks'
import { highlightSpans } from './highlighting'
import { lineStyles, markdownLineStyles } from './lineStyles'
import { noteHighlightStyle, noteMarkdown } from './markdown'
import { setWriteFocus, writeFocusTracking, writeMode } from './write'

const FRAME_MS = 8

const LOADED = ['ts', 'js', 'rust', 'python']

const CODE = [
  [
    'export function total(items: readonly { price: number }[]): number {',
    '  let sum = 0',
    '  for (const item of items) sum += item.price // a comment',
    "  return sum > 100 ? sum * 0.9 : sum + Number('1')",
    '}',
  ],
  [
    'const answer = [1, 2, 3].map((n) => n * 2).filter(Boolean)',
    "console.log(`answer: ${answer.join(', ')}`)",
  ],
  [
    'fn main() {',
    '    let v: Vec<u32> = (0..10).map(|n| n * 2).collect();',
    '    println!("{:?}", v);',
    '}',
  ],
  ['def total(items):', '    return sum(i.price for i in items)  # a comment'],
]

function section(i: number, fences: readonly string[]): string {
  const k = i % CODE.length
  return [
    `## Section ${i}`,
    '',
    'A paragraph of prose, as notes mostly have, with **bold**, *emphasis* and a [link](https://example.com).',
    '',
    '```' + fences[k],
    ...CODE[k]!,
    '```',
    '',
    'Another paragraph between the blocks, with `inline code` and a list below.',
    '',
    '- one',
    '- two',
    '',
  ].join('\n')
}

/** About 200 KB of prose and code blocks in `fences`' languages, the caret in a paragraph halfway down. */
function note(write: boolean, fences: readonly string[]): EditorState {
  let doc = ''
  for (let i = 0; doc.length < 200_000; i++) doc += section(i, fences)
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(doc.indexOf('A paragraph of prose', doc.length / 2) + 2),
    extensions: [
      noteMarkdown,
      markdownLineStyles,
      codeBlocks(),
      writeFocusTracking,
      write ? writeMode() : [],
    ],
  })
  return settled(state.update({ effects: setWriteFocus.of(true) }).state)
}

/** The parser catches up after a step, as the editor's idle work does. */
function settled(state: EditorState): EditorState {
  ensureSyntaxTree(state, state.doc.length, 1e9)
  return state.update({}).state
}

/** What the view's highlighting, code boxes and line styles draw for a screenful around the caret. */
function drawn(state: EditorState): void {
  const at = state.selection.main.head
  const shown = {
    from: Math.max(0, at - 1500),
    to: Math.min(state.doc.length, at + 1500),
  }
  highlightSpans(state, noteHighlightStyle, shown.from, shown.to)
  blockDecorations(state, [shown])
  lineStyles(state, syntaxTree(state), shown.from, shown.to)
}

const typing = (state: EditorState): TransactionSpec => {
  const at = state.selection.main.head
  return {
    changes: { from: at, insert: 'x' },
    selection: EditorSelection.cursor(at + 1),
    userEvent: 'input.type',
  }
}

const typed = (state: EditorState): EditorState => state.update(typing(state)).state

const moved = (state: EditorState): EditorState =>
  state.update({
    selection: EditorSelection.cursor(state.selection.main.head + 1),
    userEvent: 'select',
  }).state

const inProse = (state: EditorState): EditorState => state

const inBlock = (state: EditorState): EditorState => {
  const text = state.doc.toString()
  const at = text.indexOf('let sum = 0', text.length / 2) + 4
  return settled(state.update({ selection: EditorSelection.cursor(at) }).state)
}

/** The median time of a step and its drawing, after a few to warm up. */
function median(
  start: EditorState,
  place: (state: EditorState) => EditorState,
  step: (state: EditorState) => EditorState,
): number {
  let state = place(start)
  const times: number[] = []
  for (let i = 0; i < 31; i++) {
    const started = performance.now()
    state = step(state)
    drawn(state)
    if (i >= 10) times.push(performance.now() - started)
    state = settled(state)
  }
  times.sort((a, b) => a - b)
  return times[times.length >> 1]!
}

beforeAll(async () => {
  for (const name of LOADED)
    await LanguageDescription.matchLanguageName(languages, name, true)?.load()
})

for (const write of [false, true]) {
  describe(`a long note of highlighted code blocks in ${write ? 'Write' : 'Edit'} mode`, () => {
    it('types a character in prose within a frame', (context) => {
      expectWithinBudget(context, median(note(write, LOADED), inProse, typed), FRAME_MS)
    })

    it('types a character in a block within a frame', (context) => {
      expectWithinBudget(context, median(note(write, LOADED), inBlock, typed), FRAME_MS)
    })

    it('moves the caret in prose within a frame', (context) => {
      expectWithinBudget(context, median(note(write, LOADED), inProse, moved), FRAME_MS)
    })

    it('moves the caret in a block within a frame', (context) => {
      expectWithinBudget(context, median(note(write, LOADED), inBlock, moved), FRAME_MS)
    })

    // Languages no other test here loads: the test awaits nothing, so none finishes loading during it.
    it("types a character within a frame while the blocks' languages load", (context) => {
      const loading = write ? ['sql', 'css', 'xml', 'yaml'] : ['go', 'java', 'cpp', 'php']
      expectWithinBudget(context, median(note(write, loading), inProse, typed), FRAME_MS)
    })
  })
}
