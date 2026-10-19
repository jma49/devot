import { CompletionContext } from '@codemirror/autocomplete'
import { ensureSyntaxTree, indentUnit } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { gutterLineClass } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import {
  blockAt,
  blockDecorations,
  codeBlockLines,
  codeBlocks,
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

/** Each boxed line as its number, then F (first), L (last), C (a closing fence). */
const boxed = (doc: string) =>
  codeBlockLines(state(doc)).map((l) => {
    const s = state(doc)
    const n = s.doc.lineAt(l.from).number
    return `${n}${l.first ? 'F' : ''}${l.last ? 'L' : ''}${l.closing ? 'C' : ''}`
  })

describe('codeBlockLines', () => {
  it('boxes every line of a closed block, its fences included', () => {
    expect(boxed('a\n\n```js\nx\n```\n\nb')).toEqual(['3F', '4', '5LC'])
    expect(boxed('```\n```')).toEqual(['1F', '2LC'])
  })

  it('boxes an unclosed block to the end of the note', () => {
    expect(boxed('a\n\n```\nx\n\ny')).toEqual(['3F', '4', '5', '6L'])
  })

  it('boxes a block in a list item from its fence line', () => {
    expect(boxed('- item\n  ```\n  x\n  ```\n- next')).toEqual(['2F', '3', '4LC'])
  })
})

describe('the gutter beside a block', () => {
  const padded = (doc: string) => {
    const s = EditorState.create({ doc, extensions: [noteMarkdown, codeBlocks()] })
    ensureSyntaxTree(s, s.doc.length, 5000)
    // The tree is complete now: a transaction brings the field up to date.
    const t = s.update({}).state
    const lines: number[] = []
    for (const set of t.facet(gutterLineClass))
      for (let c = set.iter(); c.value; c.next()) {
        if (c.value.elementClass === 'cm-codeblock-gutter-first')
          lines.push(t.doc.lineAt(c.from).number)
      }
    return lines
  }

  it('pads the first line of each block, so its number and fold mark sit level with the fence', () => {
    expect(padded('a\n\n```js\nx\n```\n\nb\n\n```\ny')).toEqual([3, 9])
    expect(padded('no code')).toEqual([])
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

  it('starts a new line with the indent of the line before', () => {
    expect(run('```\n    ab^\n```', codeReturn)).toBe('```\n    ab\n    ^\n```')
    expect(run('```\n\tab^\n```', codeReturn)).toBe('```\n\tab\n\t^\n```')
    expect(run('```\n  ^  ab\n```', codeReturn)).toBe('```\n  \n  ^  ab\n```')
    expect(run('```js^\n```', codeReturn)).toBe('```js\n^\n```')
    expect(run('- a\n  ```\n  x^\n  ```', codeReturn)).toBe('- a\n  ```\n  x\n  ^\n  ```')
    expect(run('- a\n  ```\n    x^\n  ```', codeReturn)).toBe('- a\n  ```\n    x\n    ^\n  ```')
    expect(run('> ```\n>   x^\n> ```', codeReturn)).toBe('> ```\n>   x\n>   ^\n> ```')
    expect(run('```\nx\n```^', codeReturn)).toBeNull()
    expect(run('text^', codeReturn)).toBeNull()
  })

  it('indents one unit more after an opening bracket', () => {
    expect(run('```\nif (a) {^\n```', codeReturn)).toBe('```\nif (a) {\n  ^\n```')
    expect(run('```\n  xs = [^\n```', codeReturn)).toBe('```\n  xs = [\n    ^\n```')
    expect(run('```\nf(  ^\n```', codeReturn)).toBe('```\nf(\n  ^\n```')
  })

  it('puts the closing bracket on its own line between a pair', () => {
    expect(run('```\n  f() {^}\n```', codeReturn)).toBe('```\n  f() {\n    ^\n  }\n```')
    expect(run('```\n[^]\n```', codeReturn)).toBe('```\n[\n  ^\n]\n```')
  })

  it("indents by the block's language", () => {
    expect(run('```py\ndef f(x):^\n```', codeReturn)).toBe('```py\ndef f(x):\n    ^\n```')
    expect(run('```python\ndef f(x):\n    return x^\n```', codeReturn)).toBe(
      '```python\ndef f(x):\n    return x\n^\n```',
    )
    expect(run('```go\nfunc main() {^}\n```', codeReturn)).toBe('```go\nfunc main() {\n\t^\n}\n```')
    expect(run('- a\n  ```yaml\n  jobs:^\n  ```', codeReturn)).toBe(
      '- a\n  ```yaml\n  jobs:\n    ^\n  ```',
    )
  })

  it("follows the indent the block's lines already use", () => {
    expect(run('```py\nif a:\n  b = 1\nif c:^\n```', codeReturn)).toBe(
      '```py\nif a:\n  b = 1\nif c:\n  ^\n```',
    )
    expect(run('```js\nif (a) {\n\tb()\n}\nif (c) {^\n```', codeReturn)).toBe(
      '```js\nif (a) {\n\tb()\n}\nif (c) {\n\t^\n```',
    )
  })

  it("inserts the block's indent unit on Tab", () => {
    expect(run('```go\n^x\n```', codeTab)).toBe('```go\n\t^x\n```')
    expect(run('```py\n^x\n```', codeTab)).toBe('```py\n    ^x\n```')
  })

  it('inserts the indent unit at the cursor on Tab', () => {
    expect(run('```\na^b\n```', codeTab)).toBe('```\na  ^b\n```')
    expect(run('```^\n```', codeTab)).toBeNull()
  })
})

describe('a block split by a fold or a line gap', () => {
  const lineDecos = (doc: string, ranges: { from: number; to: number }[]) => {
    const found: number[] = []
    for (let c = blockDecorations(state(doc), ranges).iter(); c.value; c.next())
      if (c.from === c.to && c.value.spec.class?.includes('cm-codeblock')) found.push(c.from)
    return found
  }

  it('decorates each line once when two visible ranges share the block', () => {
    const doc = 'a\n\n```js\nx\ny\n```\n\nb'
    // Folded: the view shows up to the end of the opening line, then from the block's end.
    const fold = [
      { from: 0, to: 8 },
      { from: 16, to: doc.length },
    ]
    expect(lineDecos(doc, fold)).toEqual([3, 9, 11, 13])
    expect(lineDecos(doc, [{ from: 0, to: doc.length }])).toEqual([3, 9, 11, 13])
  })
})

describe('Return and Tab in the prefix of a nested block line', () => {
  const run = (marked: string, command: typeof codeReturn) => {
    const s = state(marked)
    return command(s)
  }

  it('leave the default command to a caret left of the quote marker or the item indent', () => {
    expect(run('> ```\n^> foo\n> ```', codeReturn)).toBeNull()
    expect(run('> ```\n^> foo\n> ```', codeTab)).toBeNull()
    expect(run('> ```\n>^ foo\n> ```', codeReturn)).toBeNull()
    expect(run('- a\n  ```\n^  npm i\n  ```', codeReturn)).toBeNull()
    expect(run('- a\n  ```\n ^ npm i\n  ```', codeTab)).toBeNull()
  })

  it('still work from the first column of the block text', () => {
    const s = state('> ```\n> ^foo\n> ```')
    expect(show(s.update(codeReturn(s)!).state)).toBe('> ```\n> \n> ^foo\n> ```')
    const t = state('> ```\n> ^foo\n> ```')
    expect(show(t.update(codeTab(t)!).state)).toBe('> ```\n>   ^foo\n> ```')
  })
})
