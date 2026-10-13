import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import type { PasteUrlStyle } from '../../../core/editorSettings'
import { noteMarkdown } from './markdown'
import { pasteTransaction, pastedUrl, plainPaste } from './paste'

// `|` marks a cursor, `«` and `»` a selected range.
function state(marked: string) {
  const ranges = []
  let doc = ''
  let start = -1
  for (const ch of marked) {
    if (ch === '«') start = doc.length
    else if (ch === '»') ranges.push(EditorSelection.range(start, doc.length))
    else if (ch === '|') ranges.push(EditorSelection.cursor(doc.length))
    else doc += ch
  }
  return EditorState.create({
    doc,
    selection: EditorSelection.create(ranges.length ? ranges : [EditorSelection.cursor(0)]),
    extensions: [EditorState.allowMultipleSelections.of(true), noteMarkdown, history()],
  })
}

function show(s: EditorState): string {
  const marks: [number, string][] = []
  for (const r of s.selection.ranges) {
    if (r.empty) marks.push([r.from, '|'])
    else marks.push([r.from, '«'], [r.to, '»'])
  }
  let text = s.doc.toString()
  for (const [pos, mark] of marks.sort((a, b) => b[0] - a[0]))
    text = text.slice(0, pos) + mark + text.slice(pos)
  return text
}

const after = (s: EditorState, spec: TransactionSpec | null) => {
  expect(spec).not.toBeNull()
  return s.update(spec!).state
}

/** What pasting `text` does, or null when the editor's own paste runs. */
const paste = (marked: string, text: string, style: PasteUrlStyle = 'plain') => {
  const s = state(marked)
  const spec = pasteTransaction(s, text, style)
  return spec && show(s.update(spec).state)
}

describe('pastedUrl', () => {
  it('reads one URL, trimmed', () => {
    expect(pastedUrl('https://example.com/a?b=c#d')).toBe('https://example.com/a?b=c#d')
    expect(pastedUrl('  http://example.com \n')).toBe('http://example.com')
    expect(pastedUrl('mailto:me@example.com')).toBe('mailto:me@example.com')
    expect(pastedUrl('devot://note/0192a6f0-0000-7000-8000-00000000000a')).toBe(
      'devot://note/0192a6f0-0000-7000-8000-00000000000a',
    )
    // `www.` gets its scheme.
    expect(pastedUrl('www.example.com/x')).toBe('https://www.example.com/x')
  })

  it('leaves anything else to the usual paste', () => {
    for (const text of [
      '',
      'example.com',
      'see https://example.com',
      'https://a.example https://b.example',
      'https://a.example\nhttps://b.example',
      'javascript:alert(1)',
      'ftp://example.com',
      'https://',
    ]) {
      expect({ text, result: pastedUrl(text) }).toEqual({ text, result: null })
    }
  })
})

describe('pasting a URL over selected text', () => {
  it('makes the selection a link to it, with the cursor after the link', () => {
    expect(paste('Read «the docs» now', 'https://example.com')).toBe(
      'Read [the docs](https://example.com)| now',
    )
    // Whatever the setting for a lone URL.
    expect(paste('«docs»', 'https://example.com', 'autolink')).toBe('[docs](https://example.com)|')
    expect(paste('«docs»', ' www.example.com\n')).toBe('[docs](https://www.example.com)|')
    // A copied note URI links to that note.
    expect(paste('See «Plan»', 'devot://note/0192a6f0-0000-7000-8000-00000000000a')).toBe(
      'See [Plan](devot://note/0192a6f0-0000-7000-8000-00000000000a)|',
    )
  })

  it('escapes lone brackets in the text and parentheses that would end the address', () => {
    expect(paste('«a ] b»', 'https://example.com')).toBe('[a \\] b](https://example.com)|')
    expect(paste('«wiki»', 'https://en.example.org/wiki/A_(b)')).toBe(
      '[wiki](https://en.example.org/wiki/A_(b))|',
    )
    expect(paste('«wiki»', 'https://example.org/a)b')).toBe('[wiki](https://example.org/a%29b)|')
    // A `|` would end a table cell.
    expect(paste('«q»', 'https://x.example/?q=a|b')).toBe('[q](https://x.example/?q=a%7Cb)|')
    // A backslash would escape the next character, `)` included.
    expect(paste('«text»', 'https://x.example/path\\')).toBe('[text](https://x.example/path%5C)|')
    expect(paste('«wiki»', 'https://x.example/A_(b\\)')).toBe('[wiki](https://x.example/A_(b%5C))|')
    expect(paste('|', 'https://x.example/a\\', 'link')).toBe('[|](https://x.example/a%5C)')
  })

  it('links each selected line, like Cmd+K', () => {
    expect(paste('«one\ntwo»', 'https://example.com')).toBe(
      '[one](https://example.com)|\n[two](https://example.com)|',
    )
    expect(paste('- «item»', 'https://example.com')).toBe('- [item](https://example.com)|')
    // Text in a code span: the link takes the whole span, as Cmd+K does.
    expect(paste('`«code»`', 'https://example.com')).toBe('[`code`](https://example.com)|')
  })

  it('replaces what a link cannot wrap', () => {
    // An existing link, a selected URL, code, front matter: the usual paste.
    for (const marked of [
      '[«old»](https://old.example)',
      '«https://old.example»',
      '```\n«code»\n```',
      '---\ntitle: «x»\n---\n',
    ]) {
      expect({ marked, result: paste(marked, 'https://example.com') }).toEqual({
        marked,
        result: null,
      })
    }
  })

  it('is one undo step', () => {
    const s = state('«docs»')
    const linked = after(s, pasteTransaction(s, 'https://example.com', 'plain'))
    let undone = linked
    undo({ state: linked, dispatch: (tr) => (undone = tr.state) })
    expect(show(undone)).toBe('«docs»')
  })
})

describe('pasting a URL after a bang', () => {
  it('escapes the bang, or the link over the selection would be an image', () => {
    expect(paste('Wow!«this»', 'https://example.com')).toBe('Wow\\![this](https://example.com)|')
  })
})

describe('pasting a lone URL', () => {
  it('pastes it as copied by default', () => {
    expect(paste('Go |', 'https://example.com')).toBeNull()
    expect(paste('Go |', 'https://example.com', 'plain')).toBeNull()
  })

  it('makes an autolink, with the cursor after it', () => {
    expect(paste('Go |', 'https://example.com', 'autolink')).toBe('Go <https://example.com>|')
    expect(paste('|', 'www.example.com', 'autolink')).toBe('<https://www.example.com>|')
    // An autolink cannot hold `<` or `>`: then the URL goes in as copied.
    expect(paste('|', 'https://example.com/<x>', 'autolink')).toBeNull()
    expect(paste('|', 'https://x.example/a|b', 'autolink')).toBe('<https://x.example/a%7Cb>|')
    expect(paste('|', 'https://x.example/a|b', 'link')).toBe('[|](https://x.example/a%7Cb)')
  })

  it('makes a link with empty text, with the cursor in the text', () => {
    expect(paste('Go |', 'https://example.com', 'link')).toBe('Go [|](https://example.com)')
    expect(paste('A| and B|', 'https://example.com', 'link')).toBe(
      'A[|](https://example.com) and B[|](https://example.com)',
    )
  })

  it('escapes a bang before an empty link, which would be an image', () => {
    expect(paste('Wow!|', 'https://example.com', 'link')).toBe('Wow\\![|](https://example.com)')
    expect(paste('Wow\\!|', 'https://example.com', 'link')).toBe('Wow\\![|](https://example.com)')
    // An autolink or the text as copied does not start an image.
    expect(paste('Wow!|', 'https://example.com', 'autolink')).toBe('Wow!<https://example.com>|')
    expect(paste('Wow!|', 'https://example.com', 'plain')).toBeNull()
  })

  it('pastes it as copied where Markdown is not read or a link would nest', () => {
    for (const marked of [
      '`code |`',
      '```\n|\n```',
      '---\nurl: |\n---\n',
      '[text](|)',
      '[te|xt](https://old.example)',
      '<https://old.exa|mple>',
    ]) {
      expect({ marked, result: paste(marked, 'https://example.com', 'link') }).toEqual({
        marked,
        result: null,
      })
      expect({ marked, result: paste(marked, 'https://example.com', 'autolink') }).toEqual({
        marked,
        result: null,
      })
    }
  })

  it('leaves text that is not one URL to the usual paste', () => {
    expect(paste('|', 'just text', 'link')).toBeNull()
    expect(paste('«sel»', 'just text', 'link')).toBeNull()
  })
})

describe('plainPaste', () => {
  it('inserts the text as it is, over the selection', () => {
    const s = state('Hello «there»!')
    expect(show(after(s, plainPaste(s, '[a](b) **c**')))).toBe('Hello [a](b) **c**|!')
    // A URL stays a URL, whatever the selection or setting.
    const sel = state('«docs»')
    expect(show(after(sel, plainPaste(sel, 'https://example.com')))).toBe('https://example.com|')
  })

  it('reads line breaks of every kind as one', () => {
    const s = state('|')
    expect(after(s, plainPaste(s, 'a\r\nb\rc\n')).doc.toString()).toBe('a\nb\nc\n')
  })

  it('does nothing for an empty clipboard', () => {
    expect(plainPaste(state('|'), '')).toBeNull()
  })

  it('is one undo step', () => {
    const s = state('x|')
    const pasted = after(s, plainPaste(s, 'one\ntwo'))
    let undone = pasted
    undo({ state: pasted, dispatch: (tr) => (undone = tr.state) })
    expect(show(undone)).toBe('x|')
  })
})
