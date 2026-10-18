import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { noteMarkdown } from './markdown'
import { activeBlock, unwrapLines, unwrapMode } from './unwrap'

// `^` marks the cursor.
function state(marked: string, mode: 'all' | 'active' | null = 'all') {
  const at = marked.indexOf('^')
  const doc = at < 0 ? marked : marked.slice(0, at) + marked.slice(at + 1)
  const s = EditorState.create({
    doc,
    selection: EditorSelection.cursor(Math.max(0, at)),
    extensions: [noteMarkdown, unwrapMode.of(mode)],
  })
  ensureSyntaxTree(s, s.doc.length, 5000)
  return s
}

/** The numbers of the lines that do not wrap. */
const unwrapped = (s: EditorState) =>
  unwrapLines(s, [{ from: 0, to: s.doc.length }]).flatMap((block) =>
    block.lines.map((from) => s.doc.lineAt(from).number),
  )

const NOTE = [
  'Prose that wraps.', // 1
  '', // 2
  '```js', // 3
  'const a = 1', // 4
  '```', // 5
  '', // 6
  '| a | b |', // 7
  '| - | - |', // 8
  '| 1 | 2 |', // 9
  '', // 10
  '    indented code', // 11
  '', // 12
  '> ```', // 13
  '> quoted code', // 14
  '> ```', // 15
  '', // 16
  '> [!NOTE]', // 17
  '> ```', // 18
  '> alert code', // 19
  '> ```', // 20
].join('\n')

describe('unwrapped blocks', () => {
  it('keeps every code block and table on one line each in prose mode', () => {
    // Code in a quote or an alert keeps wrapping with it.
    expect(unwrapped(state(NOTE))).toEqual([3, 4, 5, 7, 8, 9, 11])
  })

  it('unwraps only the block under the caret at cursor', () => {
    const lines = NOTE.split('\n')
    const at = (line: number, column = 0) =>
      state(
        lines
          .map((text, i) =>
            i === line - 1 ? text.slice(0, column) + '^' + text.slice(column) : text,
          )
          .join('\n'),
        'active',
      )
    expect(unwrapped(at(1))).toEqual([])
    expect(unwrapped(at(4, 3))).toEqual([3, 4, 5])
    // At the end of a block's last line the caret is still in it.
    expect(unwrapped(at(5, 3))).toEqual([3, 4, 5])
    expect(unwrapped(at(8))).toEqual([7, 8, 9])
    expect(unwrapped(at(9, 9))).toEqual([7, 8, 9])
    expect(unwrapped(at(11, 6))).toEqual([11])
    expect(unwrapped(at(14, 4))).toEqual([])
    expect(unwrapped(at(19, 4))).toEqual([])
    expect(unwrapped(at(6))).toEqual([])
  })

  it('unwraps nothing when wrapping is off or all', () => {
    expect(unwrapped(state(NOTE, null))).toEqual([])
  })

  it('looks only at the ranges asked for', () => {
    const s = state(NOTE)
    const table = s.doc.line(8).from
    expect(
      unwrapLines(s, [{ from: table, to: table }]).flatMap((b) =>
        b.lines.map((from) => s.doc.lineAt(from).number),
      ),
    ).toEqual([7, 8, 9])
  })

  it('follows the caret through edits', () => {
    const s = state('Text\n\n```\nco^de\n```', 'active')
    const block = activeBlock(s)
    expect(block?.from).toBe(s.doc.line(3).from)
    // Typing above the block moves it; the caret stays inside.
    const typed = s.update({ changes: { from: 0, insert: 'More\n' } }).state
    ensureSyntaxTree(typed, typed.doc.length, 5000)
    expect(activeBlock(typed)?.from).toBe(typed.doc.line(4).from)
    // Leaving it to the prose above wraps it again.
    const left = typed.update({ selection: { anchor: 1 } }).state
    expect(activeBlock(left)).toBeNull()
    expect(unwrapped(left)).toEqual([])
  })
})
