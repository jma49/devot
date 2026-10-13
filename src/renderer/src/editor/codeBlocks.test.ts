import { CompletionContext } from '@codemirror/autocomplete'
import { ensureSyntaxTree, indentUnit } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  blockAt,
  codeBlockLines,
  codeReturn,
  codeTab,
  copyText,
  fenceInfoAt,
  languageOptions,
  languageSource,
} from './codeBlocks'
import { FORMAT_COMMANDS } from './formats'
import { noteMarkdown } from './markdown'

// `^` marks the cursor.
function state(marked: string) {
  const at = marked.indexOf('^')
  const doc = at < 0 ? marked : marked.slice(0, at) + marked.slice(at + 1)
  const s = EditorState.create({
    doc,
    selection: EditorSelection.cursor(Math.max(0, at)),
    extensions: [noteMarkdown, indentUnit.of('  ')],
  })
  ensureSyntaxTree(s, s.doc.length, 5000)
  return s
}

const show = (s: EditorState) => {
  const head = s.selection.main.head
  const text = s.doc.toString()
  return text.slice(0, head) + '^' + text.slice(head)
}

/** Each boxed line as `number:first/last`. */
const boxed = (doc: string) =>
  codeBlockLines(state(doc)).map((l) => {
    const s = state(doc)
    const n = s.doc.lineAt(l.from).number
    return `${n}${l.first ? 'F' : ''}${l.last ? 'L' : ''}`
  })

describe('codeBlockLines', () => {
  it('boxes every line of a closed block, its fences included', () => {
    expect(boxed('a\n\n```js\nx\n```\n\nb')).toEqual(['3F', '4', '5L'])
    expect(boxed('```\n```')).toEqual(['1F', '2L'])
  })

  it('boxes an unclosed block to the end of the note', () => {
    expect(boxed('a\n\n```\nx\n\ny')).toEqual(['3F', '4', '5', '6L'])
  })

  it('boxes a block in a list item from its fence line', () => {
    expect(boxed('- item\n  ```\n  x\n  ```\n- next')).toEqual(['2F', '3', '4L'])
  })
})

describe('copyText', () => {
  const copied = (doc: string, pos: number) => {
    const s = state(doc)
    return copyText(s, blockAt(s, pos)!)
  }
  it('copies the code without its fences', () => {
    expect(copied('```js:file.js\nconst a = 1\n\n  b()\n```', 5)).toBe('const a = 1\n\n  b()')
    expect(copied('```\n```', 1)).toBe('')
    // An unclosed block: everything after the fence.
    expect(copied('```\nx\ny', 1)).toBe('x\ny')
  })

  it('takes off the indentation of a block in a list item', () => {
    expect(copied('- item\n  ```\n  x\n    y\n  ```', 10)).toBe('x\n  y')
  })
})

describe('languageOptions', () => {
  it('lists every alias, matching fuzzily', () => {
    const all = languageOptions('')
    expect(all.length).toBeGreaterThan(150)
    expect(all.find((l) => l.alias === 'bash')?.name).toBe('Shell')
    const js = languageOptions('js')
    expect(
      js
        .slice(0, 3)
        .map((l) => l.alias)
        .sort(),
    ).toEqual(['js', 'json', 'jsx'])
    expect(js[0]?.alias).toBe('js')
    expect(js.some((l) => l.alias === 'javascript')).toBe(true)
  })
})

describe('the language list', () => {
  const context = (marked: string, explicit: boolean) => {
    const s = state(marked)
    return new CompletionContext(s, s.selection.main.head, explicit)
  }

  it('opens on an opening fence when asked, or once a letter is typed', () => {
    expect(fenceInfoAt(state('```^\n\n```'))).toEqual({ fence: '```', from: 3, to: 3 })
    expect(languageSource(context('```^\n\n```', true))?.options.length).toBeGreaterThan(150)
    // A fence typed by hand opens nothing on its own.
    expect(languageSource(context('```^', false))).toBeNull()
    const typed = languageSource(context('```rus^', false))
    expect(typed?.from).toBe(3)
    expect(typed?.options[0]?.label).toBe('rust')
    expect(typed?.options[0]?.displayLabel).toBe('```rust')
  })

  it('stays closed off the opening fence', () => {
    expect(fenceInfoAt(state('```\nx^\n```'))).toBeNull()
    expect(fenceInfoAt(state('```\nx\n```^'))).toBeNull()
    expect(fenceInfoAt(state('``^`'))).toBeNull()
    expect(fenceInfoAt(state('```js x^'))).toBeNull()
  })
})

describe('Code Block', () => {
  it('puts the cursor right after the opening fence of a new block', () => {
    const s = state('^')
    expect(show(s.update(FORMAT_COMMANDS.codeBlock(s)!).state)).toBe('```^\n\n```')
    const t = state('Intro\n\n^')
    expect(show(t.update(FORMAT_COMMANDS.codeBlock(t)!).state)).toBe('Intro\n\n```^\n\n```')
  })

  it('still wraps a line with text, the cursor staying in it', () => {
    const s = state('co^de')
    expect(show(s.update(FORMAT_COMMANDS.codeBlock(s)!).state)).toBe('```\nco^de\n```')
  })
})

describe('typing in a block', () => {
  const run = (marked: string, command: typeof codeReturn) => {
    const s = state(marked)
    const tr = command(s)
    return tr && show(s.update(tr).state)
  }

  it('starts a new line with no indent of its own', () => {
    expect(run('```\n    ab^\n```', codeReturn)).toBe('```\n    ab\n^\n```')
    expect(run('```js^\n```', codeReturn)).toBe('```js\n^\n```')
    // In a list item the line keeps the item's indent, so it stays in the block.
    expect(run('- a\n  ```\n  x^\n  ```', codeReturn)).toBe('- a\n  ```\n  x\n  ^\n  ```')
    expect(run('```\nx\n```^', codeReturn)).toBeNull()
    expect(run('text^', codeReturn)).toBeNull()
  })

  it('inserts the indent unit at the cursor on Tab', () => {
    expect(run('```\na^b\n```', codeTab)).toBe('```\na  ^b\n```')
    expect(run('```^\n```', codeTab)).toBeNull()
  })
})
