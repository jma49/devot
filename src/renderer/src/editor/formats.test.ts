import { history, undo } from '@codemirror/commands'
import {
  Language,
  LanguageSupport,
  defineLanguageFacet,
  ensureSyntaxTree,
} from '@codemirror/language'
import {
  EditorSelection,
  EditorState,
  type Extension,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { NodeType, Parser, Tree, type PartialParse } from '@lezer/common'
import { describe, expect, it, vi } from 'vitest'
import { expectWithinBudget, skipIfOverloaded } from '../../../../tests/support/budget'
import {
  FORMAT_COMMANDS,
  cycleHeading,
  formatCommand,
  formatState,
  inertFormats,
  insertImage,
  isInlineActive,
  linkTo,
  setHeading,
  stepHeading,
  toggleInline,
  toggleLink,
  type FormatId,
  type InlineFormat,
} from './formats'
import { TOOLBAR_MAX_LINES } from './formatContext'
import { noteMarkdown, noteParser } from './markdown'
import { previewTexts } from '../../../../tests/support/preview-html'

// Test documents mark the selection inline: `«` is where a range starts and
// `»` where it ends; `|` is a cursor. Several ranges may appear.
function state(marked: string, extensions: Extension[] = [noteMarkdown]) {
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
    extensions: [EditorState.allowMultipleSelections.of(true), ...extensions],
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

function apply(s: EditorState, spec: TransactionSpec | null): EditorState {
  expect(spec).not.toBeNull()
  return s.update(spec ?? {}).state
}

const inline = (marked: string, format: InlineFormat) => {
  const s = state(marked)
  return show(apply(s, toggleInline(s, format)))
}

describe('inline formats on plain text', () => {
  it.each<[InlineFormat, string]>([
    ['bold', 'a **«word»** b'],
    ['italic', 'a *«word»* b'],
    ['strikethrough', 'a ~~«word»~~ b'],
    ['highlight', 'a <mark>«word»</mark> b'],
    ['code', 'a `«word»` b'],
  ])('%s wraps the selection and keeps it selected', (format, expected) => {
    expect(inline('a «word» b', format)).toBe(expected)
  })

  it('keeps spaces at the edges of the selection outside the markers', () => {
    expect(inline('a« word »b', 'bold')).toBe('a **«word»** b')
  })

  it('does nothing for a selection of spaces only', () => {
    const s = state('a«   »b')
    expect(toggleInline(s, 'bold')).toBeNull()
  })

  it('fences code that holds backticks with a longer run', () => {
    expect(inline('a «b`c» d', 'code')).toBe('a ``«b`c»`` d')
    expect(inline('«`x»', 'code')).toBe('`` «`x» ``')
  })

  it('formats each line of a multi-line selection, after block markers', () => {
    expect(inline('«# Title\n- item\n\n> quote»', 'bold')).toBe(
      '# **«Title**\n- **item**\n\n> **quote»**',
    )
    expect(inline('1. «one\n2. two»', 'italic')).toBe('1. *«one*\n2. *two»*')
    expect(inline('- [ ] «task»', 'strikethrough')).toBe('- [ ] ~~«task»~~')
  })

  it('formats every range of a multiple selection', () => {
    expect(inline('«a» and «b»', 'code')).toBe('`«a»` and `«b»`')
  })

  it('joins with a touching span of the same format', () => {
    expect(inline('**a**«b»', 'bold')).toBe('**a«b»**')
    expect(inline('«a»*b*', 'italic')).toBe('*«a»b*')
  })

  it('treats bold and italic as different formats', () => {
    expect(inline('**«word»**', 'italic')).toBe('***«word»***')
    expect(inline('*«word»*', 'bold')).toBe('***«word»***')
  })
})

describe('inline formats on formatted text (toggle off)', () => {
  it.each<[InlineFormat, string]>([
    ['bold', 'a **«word»** b'],
    ['italic', 'a *«word»* b'],
    ['strikethrough', 'a ~~«word»~~ b'],
    ['highlight', 'a <mark>«word»</mark> b'],
    ['code', 'a `«word»` b'],
  ])('%s removes its markers around the selection', (format, marked) => {
    expect(inline(marked, format)).toBe('a «word» b')
  })

  it('removes markers that are part of the selection', () => {
    expect(inline('a «**word**» b', 'bold')).toBe('a «word» b')
    expect(inline('«<mark>word</mark>»', 'highlight')).toBe('«word»')
  })

  it('removes the other marker spellings', () => {
    expect(inline('__«word»__', 'bold')).toBe('«word»')
    expect(inline('_«word»_', 'italic')).toBe('«word»')
    expect(inline('``«a`b»``', 'code')).toBe('«a`b»')
  })

  it('removes one format and keeps the other', () => {
    expect(inline('***«word»***', 'bold')).toBe('*«word»*')
    expect(inline('***«word»***', 'italic')).toBe('**«word»**')
  })

  it('removes the format from every line', () => {
    expect(inline('**«one**\n**two»**', 'bold')).toBe('«one\ntwo»')
  })

  it('round-trips: applying twice gives the original text back', () => {
    for (const format of ['bold', 'italic', 'strikethrough', 'highlight', 'code'] as const) {
      const s = state('Some «plain words» here\n«and more»')
      const once = apply(s, toggleInline(s, format))
      const twice = apply(once, toggleInline(once, format))
      expect(show(twice)).toBe(show(s))
    }
  })
})

describe('inline formats on partial selections', () => {
  it('removes the format from the selected part of a span only', () => {
    expect(inline('**«bold» text**', 'bold')).toBe('«bold» **text**')
    expect(inline('**bold «text»**', 'bold')).toBe('**bold** «text»')
    expect(inline('~~on«e tw»o~~', 'strikethrough')).toBe('~~on~~«e tw»~~o~~')
    expect(inline('<mark>a «b» c</mark>', 'highlight')).toBe('<mark>a</mark> «b» <mark>c</mark>')
  })

  it('extends the format over a selection that is only partly formatted', () => {
    expect(inline('plain «text **bo»ld**', 'bold')).toBe('plain **«text bo»ld**')
    expect(inline('«a *b* c»', 'italic')).toBe('*«a b c»*')
    expect(inline('«x `y`» z', 'code')).toBe('`«x y»` z')
  })

  it('formats a mixed multi-line selection fully', () => {
    expect(inline('«**one**\ntwo»', 'bold')).toBe('**«one**\n**two»**')
  })
})

describe('inline formats at a cursor', () => {
  it('inserts an empty pair with the cursor between', () => {
    expect(inline('ab|c', 'bold')).toBe('ab**|**c')
    expect(inline('|', 'highlight')).toBe('<mark>|</mark>')
  })

  it('removes the span the cursor is in', () => {
    expect(inline('a **bo|ld** b', 'bold')).toBe('a bo|ld b')
    expect(inline('`co|de`', 'code')).toBe('co|de')
  })
})

describe('isInlineActive', () => {
  it('is on only when the whole selection has the format', () => {
    expect(isInlineActive(state('a «word» b'), 'bold')).toBe(false)
    expect(isInlineActive(state('a **«word»** b'), 'bold')).toBe(true)
    expect(isInlineActive(state('a «**word**» b'), 'bold')).toBe(true)
    expect(isInlineActive(state('**«bo»ld**'), 'bold')).toBe(true)
    expect(isInlineActive(state('«plain **bold**»'), 'bold')).toBe(false)
    expect(isInlineActive(state('**«one**\n**two»**'), 'bold')).toBe(true)
    expect(isInlineActive(state('**«word»**'), 'italic')).toBe(false)
    expect(isInlineActive(state('a **wo|rd**'), 'bold')).toBe(true)
  })
})

describe('headings', () => {
  const heading = (marked: string, level: number) => {
    const s = state(marked)
    return show(apply(s, setHeading(s, level)))
  }
  const cycle = (marked: string) => {
    const s = state(marked)
    return show(apply(s, cycleHeading(s)))
  }

  it('sets the level of the line', () => {
    expect(heading('Ti|tle', 2)).toBe('## Ti|tle')
    expect(heading('# Ti|tle', 3)).toBe('### Ti|tle')
    expect(heading('|Title', 1)).toBe('# |Title')
    expect(heading('> «quote»', 1)).toBe('> «# quote»')
  })

  it('removes the heading when the line already has that level', () => {
    expect(heading('## Ti|tle', 2)).toBe('Ti|tle')
  })

  it('sets every non-empty line of a multi-line selection', () => {
    expect(heading('«one\n\n## two»', 2)).toBe('«## one\n\n## two»')
    expect(heading('«## one\n## two»', 2)).toBe('«one\ntwo»')
  })

  it('cycles through the levels and back to none', () => {
    expect(cycle('Ti|tle')).toBe('# Ti|tle')
    expect(cycle('# Ti|tle')).toBe('## Ti|tle')
    expect(cycle('##### «Title»')).toBe('###### «Title»')
    expect(cycle('###### Ti|tle')).toBe('Ti|tle')
  })

  it('steps each line on its own, bigger and smaller', () => {
    const step = (marked: string, way: 'bigger' | 'smaller') => {
      const s = state(marked)
      return show(apply(s, stepHeading(s, way)))
    }
    expect(step('Ti|tle', 'smaller')).toBe('# Ti|tle')
    expect(step('# Ti|tle', 'smaller')).toBe('## Ti|tle')
    expect(step('###### Ti|tle', 'smaller')).toBe('Ti|tle')
    expect(step('Ti|tle', 'bigger')).toBe('###### Ti|tle')
    expect(step('## Ti|tle', 'bigger')).toBe('# Ti|tle')
    expect(step('# Ti|tle', 'bigger')).toBe('Ti|tle')
    expect(step('«# one\ntwo\n### three»', 'smaller')).toBe('«## one\n# two\n#### three»')
    expect(step('«# one\ntwo»', 'bigger')).toBe('«one\n###### two»')
    expect(step('> - ## it|em', 'bigger')).toBe('> - # it|em')
    expect(step('Ti|tle\n===', 'smaller')).toBe('## Ti|tle')
    expect(step('Ti|tle\n===', 'bigger')).toBe('Ti|tle')
  })

  it('reads the level of a line', () => {
    expect(cycle('### Ti|tle')).toBe('#### Ti|tle')
    expect(cycle('> ## Quo|te')).toBe('> ### Quo|te')
    expect(cycle('#hash|tag')).toBe('# #hash|tag')
    expect(cycle('####### se|ven')).toBe('# ####### se|ven')
  })
})

describe('links', () => {
  const link = (marked: string) => {
    const s = state(marked)
    return show(apply(s, toggleLink(s)))
  }

  it('wraps the selection with an empty URL and puts the cursor in it', () => {
    expect(link('see «the docs» here')).toBe('see [the docs](|) here')
  })

  it('uses a selected URL as the address and puts the cursor in the text', () => {
    expect(link('«https://example.com/a»')).toBe('[|](https://example.com/a)')
  })

  it('inserts an empty link at a cursor', () => {
    expect(link('a |b')).toBe('a [|]()b')
  })

  it('links each line of a multi-line selection', () => {
    expect(link('«one\ntwo»')).toBe('[one](|)\n[two](|)')
  })

  it('removes a link that is selected or partly selected, keeping its text', () => {
    expect(link('see [«docs»](https://x.y) here')).toBe('see «docs» here')
    expect(link('see «[docs](https://x.y)» here')).toBe('see «docs» here')
    expect(link('[do«c»s](u)')).toBe('do«c»s')
    expect(link('[do|cs](u)')).toBe('do|cs')
  })
})

describe('transactions', () => {
  it('each command is one transaction and one undo step', () => {
    const ids: FormatId[] = ['bold', 'italic', 'strikethrough', 'highlight', 'code', 'link']
    for (const id of ids) {
      let s = state('', [noteMarkdown, history()])
      // Typing right before and right after: neither joins the format's step.
      s = s.update({ changes: { from: 0, insert: 'word' }, userEvent: 'input.type' }).state
      s = s.update({ selection: EditorSelection.range(0, 4), userEvent: 'select' }).state
      const spec = FORMAT_COMMANDS[id](s)
      const formatted = apply(s, spec)
      expect(formatted.doc.toString()).not.toBe('word')
      const end = formatted.selection.main.head
      const typed = formatted.update({
        changes: { from: end, insert: 'x' },
        userEvent: 'input.type',
      })
      let after = typed.state
      const steps: string[] = []
      for (let i = 0; i < 3; i++) {
        undo({ state: after, dispatch: (tr: Transaction) => (after = tr.state) })
        steps.push(after.doc.toString())
      }
      expect({ id, steps }).toEqual({ id, steps: [formatted.doc.toString(), 'word', ''] })
    }
  })

  it('marks format transactions so the editor can tell them from typing', () => {
    const s = state('«a»')
    const tr = s.update(toggleInline(s, 'bold') ?? {})
    expect(tr.isUserEvent('input.format')).toBe(true)
  })
})

describe('formatState', () => {
  it('reports what the toolbar shows as pressed', () => {
    expect(formatState(state('## **«a»**'))).toEqual({
      heading: true,
      bold: true,
      italic: false,
      strikethrough: false,
      highlight: false,
      link: false,
      code: false,
      codeBlock: false,
      bulletList: false,
      numberedList: false,
      taskList: false,
      quote: false,
      alert: false,
    })
    expect(formatState(state('[«a»](u)')).link).toBe(true)
  })
})

const docOf = (s: EditorState, spec: TransactionSpec | null) => apply(s, spec).doc.toString()

describe('links and bracketed text', () => {
  const link = (marked: string) => {
    const s = state(marked)
    return show(apply(s, toggleLink(s)))
  }

  it('keeps the brackets of [[...]] text and of bracketed words that are not links', () => {
    expect(link('see [[No|te]] here')).toBe('see [[No[|]()te]] here')
    expect(link('see «[[Note]]» here')).toBe('see [[[Note]]](|) here')
    expect(link('«[draft] notes»')).toBe('[[draft] notes](|)')
  })

  it('removes reference links', () => {
    expect(link('[do|cs][ref]')).toBe('do|cs')
  })

  it('does not show bracketed text as a link', () => {
    expect(formatState(state('«[draft]» notes')).link).toBe(false)
    expect(formatState(state('see [[No|te]]')).link).toBe(false)
  })
})

describe('multi-line selections across other blocks', () => {
  const inlineDoc = (marked: string, format: InlineFormat) => {
    const s = state(marked)
    return docOf(s, toggleInline(s, format))
  }
  const headingDoc = (marked: string, level: number) => {
    const s = state(marked)
    return docOf(s, setHeading(s, level))
  }

  it('leaves fenced and indented code alone', () => {
    expect(inlineDoc('«intro\n```js\nconst a = 1\n```\nend»', 'bold')).toBe(
      '**intro**\n```js\nconst a = 1\n```\n**end**',
    )
    expect(inlineDoc('«a\n\n    code\n\nb»', 'italic')).toBe('*a*\n\n    code\n\n*b*')
    expect(headingDoc('«intro\n```js\nconst a = 1\n```\nend»', 1)).toBe(
      '# intro\n```js\nconst a = 1\n```\n# end',
    )
  })

  it('formats the cells of a table and leaves its delimiter row alone', () => {
    // `|` marks a cursor in `state()`, so these states are built directly.
    const all = (doc: string) =>
      EditorState.create({
        doc,
        selection: EditorSelection.single(0, doc.length),
        extensions: [noteMarkdown],
      })
    const table = all('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(docOf(table, toggleInline(table, 'bold'))).toBe(
      '| **a** | **b** |\n|---|---|\n| **1** | **2** |',
    )
    const mixed = all('x\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(docOf(mixed, setHeading(mixed, 2))).toBe('## x\n\n| a | b |\n|---|---|\n| 1 | 2 |')
  })

  it('leaves thematic breaks and HTML blocks alone', () => {
    expect(inlineDoc('«a\n\n---\n\n<div>\nx\n</div>\n\nb»', 'bold')).toBe(
      '**a**\n\n---\n\n<div>\nx\n</div>\n\n**b**',
    )
    expect(headingDoc('«a\n\n***\n\nb»', 3)).toBe('### a\n\n***\n\n### b')
  })

  it('returns null when every selected line is code', () => {
    const s = state('```\n«code»\n```')
    expect(toggleInline(s, 'bold')).toBeNull()
    expect(setHeading(s, 1)).toBeNull()
  })
})

describe('inertFormats', () => {
  it('lists the formats that do nothing in code, so the menu leaves their keys alone', () => {
    const inCode = inertFormats(state('```\n|code\n```'))
    for (const id of ['bold', 'italic', 'strikethrough', 'highlight', 'link'] as const)
      expect(inCode).toContain(id)
    expect(inertFormats(state('```\n«code»\n```'))).toContain('italic')
  })

  it('lists none in text, where every one of them applies', () => {
    for (const marked of ['a |word', '«word»', 'a **b|** c', '- item |x'])
      expect([marked, inertFormats(state(marked))]).toEqual([marked, []])
  })

  it('agrees with the command: a listed format returns no transaction, the others do', () => {
    const s = state('text\n\n```\n|code\n```')
    const inert = inertFormats(s)
    for (const id of Object.keys(FORMAT_COMMANDS) as FormatId[])
      expect(FORMAT_COMMANDS[id](s) === null).toBe(inert.includes(id))
  })

  it('lists nothing for a long selection', () => {
    const long = `\`\`\`\n${'x'.repeat(6000)}\n\`\`\``
    const s = EditorState.create({
      doc: long,
      selection: EditorSelection.single(4, 5500),
      extensions: [noteMarkdown],
    })
    expect(inertFormats(s)).toEqual([])
  })
})

describe('headings on list items', () => {
  const heading = (marked: string, level: number) => {
    const s = state(marked)
    return show(apply(s, setHeading(s, level)))
  }

  it('puts the heading after the list marker', () => {
    expect(heading('- «item»', 1)).toBe('- «# item»')
    expect(heading('1. «one»', 2)).toBe('1. «## one»')
    expect(heading('> - it|em', 1)).toBe('> - # it|em')
    expect(heading('- # it|em', 1)).toBe('- it|em')
    expect(heading('- # it|em', 3)).toBe('- ### it|em')
    expect(heading('- ## it|em', 2)).toBe('- it|em')
    const s = state('- it|em')
    expect(show(apply(s, cycleHeading(s)))).toBe('- # it|em')
  })

  it('leaves task items alone', () => {
    const s = state('- [ ] «task»')
    expect(setHeading(s, 2)).toBeNull()
    const both = state('«para\n- [ ] task»')
    expect(docOf(both, setHeading(both, 1))).toBe('# para\n- [ ] task')
  })
})

describe('text that only looks like a list marker', () => {
  // One paragraph in CommonMark: the second line is not an item.
  const wrapped = 'We shipped in\n2020. Then| we grew.'
  const heading = (marked: string, level: number) => {
    const s = state(marked)
    return show(apply(s, setHeading(s, level)))
  }

  it('is text for a heading, not a marker the heading goes after', () => {
    expect(heading(wrapped, 2)).toBe('We shipped in\n## 2020. Then| we grew.')
    expect(heading('We moved on\n3) Then| we left.', 1)).toBe('We moved on\n# 3) Then| we left.')
    const s = state(wrapped)
    expect(show(apply(s, cycleHeading(s)))).toBe('We shipped in\n# 2020. Then| we grew.')
    // A real item still takes the heading after its marker.
    expect(heading('- 2020 was good|', 2)).toBe('- ## 2020 was good|')
    expect(heading('1. a\n2. b|', 2)).toBe('1. a\n2. ## b|')
  })

  it('is inside the new markers of an inline format', () => {
    expect(inline('We shipped in\n«2020. Then we grew.»', 'bold')).toBe(
      'We shipped in\n**«2020. Then we grew.»**',
    )
    expect(inline('We moved on\n«3) Then we left.»', 'italic')).toBe(
      'We moved on\n*«3) Then we left.»*',
    )
    // After a real marker the markers go after it.
    expect(inline('- «2020 was good»', 'bold')).toBe('- **«2020 was good»**')
    expect(inline('1. «one»\n2. «two»', 'bold')).toBe('1. **«one»**\n2. **«two»**')
  })
})

describe('an alert header', () => {
  const doc = (marked: string, format: InlineFormat) => {
    const s = state(marked)
    return docOf(s, toggleInline(s, format))
  }
  const FORMATS: InlineFormat[] = ['bold', 'italic', 'strikethrough', 'highlight', 'code']

  it('is left alone by every inline format, the lines under it are formatted', () => {
    for (const format of FORMATS) {
      const only = state('> «[!NOTE]»')
      expect({ format, spec: toggleInline(only, format) }).toEqual({ format, spec: null })
      const at = state('> [!NO|TE]')
      expect({ format, spec: toggleInline(at, format) }).toEqual({ format, spec: null })
    }
    expect(doc('«> [!NOTE]\n> text»', 'bold')).toBe('> [!NOTE]\n> **text**')
    expect(doc('«> [!TIP]\n> text»', 'italic')).toBe('> [!TIP]\n> *text*')
    expect(doc('«[!NOTE]\ntext»', 'bold')).toBe('**[!NOTE]**\n**text**')
    // Only the first line of a quote is a header.
    expect(doc('> a\n> «[!NOTE]»', 'bold')).toBe('> a\n> **[!NOTE]**')
  })

  it('takes no heading, link or image, and the toolbar shows no format on it', () => {
    const only = state('> «[!WARNING]»')
    expect(setHeading(only, 2)).toBeNull()
    expect(cycleHeading(only)).toBeNull()
    expect(toggleLink(only)).toBeNull()
    expect(insertImage(only)).toBeNull()
    const all = state('«> [!NOTE]\n> text»')
    expect(docOf(all, toggleLink(all))).toBe('> [!NOTE]\n> [text]()')
    expect(docOf(all, setHeading(all, 2))).toBe('> [!NOTE]\n> ## text')
  })
})

describe('a bang before a link', () => {
  const link = (marked: string) => {
    const s = state(marked)
    return show(apply(s, toggleLink(s)))
  }
  const bangs = async (markdown: string) => (await previewTexts(markdown, 'img')).length

  it('is escaped, or the link would be an image', async () => {
    expect(link('Hi!«there»')).toBe('Hi\\![there](|)')
    expect(link('Hi!|')).toBe('Hi\\![|]()')
    expect(link('Wow!«one»\n«two»')).toBe('Wow\\![one](|)\n[two](|)')
    expect(await bangs('Hi\\![there](u)')).toBe(0)
    expect(await bangs('Hi![there](u)')).toBe(1)
  })

  it('stays as it is where it is not a bang before brackets already', () => {
    // Already escaped: one backslash escapes it, two escape each other.
    expect(link('Hi\\!«there»')).toBe('Hi\\![there](|)')
    expect(link('Hi\\\\!«there»')).toBe('Hi\\\\\\![there](|)')
    // Not directly before the link.
    expect(link('Hi! «there»')).toBe('Hi! [there](|)')
    expect(link('«!there»')).toBe('[!there](|)')
    expect(link('!|')).toBe('\\![|]()')
  })

  it('is not escaped before an image, which a bang there is the start of', () => {
    const s = state('Hi!«there»')
    expect(show(apply(s, insertImage(s)))).toBe('Hi!![there](|)')
  })

  it('is escaped when a URL is pasted over the selected text', () => {
    const s = state('Hi!«there»')
    expect(show(apply(s, linkTo(s, 'https://example.com')))).toBe(
      'Hi\\![there](https://example.com)|',
    )
  })
})

// Characters are built from code points, so this file stays ASCII.
const cp = (...points: number[]) => String.fromCodePoint(...points)
const X = cp(0x4e2d)
const Y = cp(0x6587)
const Z = cp(0x5b57)
const STOP = cp(0x3002) // ideographic full stop
const COMMA = cp(0xff0c)
const OPEN = cp(0xff08) // fullwidth parenthesis
const CLOSE = cp(0xff09)
const QUOTE_OPEN = cp(0x300c)
const QUOTE_CLOSE = cp(0x300d)
const SMILE = cp(0x1f600)
const IDEOGRAPHIC_SPACE = cp(0x3000)

/** The tag the preview makes of text in this format, as `<strong>` or `<em>`. */
const TAGS: Record<'bold' | 'italic' | 'strikethrough', string> = {
  bold: 'strong',
  italic: 'em',
  strikethrough: 'del',
}

describe('emphasis next to punctuation', () => {
  const FORMATS = ['bold', 'italic', 'strikethrough'] as const
  const toggle = (marked: string, format: InlineFormat) => {
    const s = state(marked)
    return apply(s, toggleInline(s, format))
  }
  /** What the editor's parser and the preview's read as the format's text. */
  async function formatted(doc: string, format: (typeof FORMATS)[number]) {
    const node = { bold: 'StrongEmphasis', italic: 'Emphasis', strikethrough: 'Strikethrough' }[
      format
    ]
    const found: string[] = []
    noteParser.parse(doc).iterate({
      enter(n) {
        if (n.name === node) found.push(doc.slice(n.from, n.to))
      },
    })
    return { editor: found, preview: await previewTexts(doc, TAGS[format]) }
  }

  it('moves punctuation at the edges of the selection outside the markers', async () => {
    for (const format of FORMATS) {
      const [open, close] =
        format === 'bold' ? ['**', '**'] : format === 'italic' ? ['*', '*'] : ['~~', '~~']
      // A full stop after the text, between ideographs (no spaces in this prose).
      const stop = toggle(`${X}${X}«${Y}${Y}${STOP}»${Z}${Z}`, format)
      expect(stop.doc.toString()).toBe(`${X}${X}${open}${Y}${Y}${close}${STOP}${Z}${Z}`)
      expect(await formatted(stop.doc.toString(), format)).toEqual({
        editor: [`${open}${Y}${Y}${close}`],
        preview: [`${Y}${Y}`],
      })
      // Fullwidth brackets and corner quotes around the text, both edges.
      for (const [a, b] of [
        [OPEN, CLOSE],
        [QUOTE_OPEN, QUOTE_CLOSE],
      ] as const) {
        const bracketed = toggle(`${X}«${a}${Y}${Y}${b}»${Z}`, format)
        expect(bracketed.doc.toString()).toBe(`${X}${a}${open}${Y}${Y}${close}${b}${Z}`)
        expect((await formatted(bracketed.doc.toString(), format)).preview).toEqual([`${Y}${Y}`])
      }
      // Latin text and a full stop with a letter right after.
      const latin = toggle('a «word.»b', format)
      expect(latin.doc.toString()).toBe(`a ${open}word${close}.b`)
      expect((await formatted(latin.doc.toString(), format)).preview).toEqual(['word'])
      // Several marks at an edge: the last one before an ideograph goes out, a
      // comma before it may stay.
      const many = toggle(`${X}«${Y}${SMILE}${COMMA}${STOP}»${Z}`, format)
      expect(many.doc.toString()).toBe(`${X}${open}${Y}${SMILE}${COMMA}${close}${STOP}${Z}`)
      expect((await formatted(many.doc.toString(), format)).preview).toEqual([
        `${Y}${SMILE}${COMMA}`,
      ])
    }
  })

  it('reads the character beside a marker as the parsers do, one UTF-16 unit', async () => {
    // Both parsers see half of a character outside the BMP: never white space or punctuation.
    const AEGEAN = cp(0x10100) // punctuation, outside the BMP
    for (const format of FORMATS) {
      const [open, close] =
        format === 'bold' ? ['**', '**'] : format === 'italic' ? ['*', '*'] : ['~~', '~~']
      // So a full stop before it cannot close: it goes outside.
      const stop = toggle(`«foo.»${AEGEAN}`, format)
      expect(stop.doc.toString()).toBe(`${open}foo${close}.${AEGEAN}`)
      expect(await formatted(stop.doc.toString(), format)).toEqual({
        editor: [`${open}foo${close}`],
        preview: ['foo'],
      })
      // And an emoji at an edge stays inside, between letters too.
      const emoji = toggle(`a«${SMILE}»b`, format)
      expect(emoji.doc.toString()).toBe(`a${open}${SMILE}${close}b`)
      expect((await formatted(emoji.doc.toString(), format)).preview).toEqual([SMILE])
    }
  })

  it('leaves the selection as it is where the markers already parse', () => {
    for (const format of FORMATS) {
      const [open, close] =
        format === 'bold' ? ['**', '**'] : format === 'italic' ? ['*', '*'] : ['~~', '~~']
      expect(toggle(`«${OPEN}${Y}${CLOSE}»`, format).doc.toString()).toBe(
        `${open}${OPEN}${Y}${CLOSE}${close}`,
      )
      expect(toggle(`a «(b)» c`, format).doc.toString()).toBe(`a ${open}(b)${close} c`)
      expect(toggle(`${X} «${Y}${STOP}»`, format).doc.toString()).toBe(
        `${X} ${open}${Y}${STOP}${close}`,
      )
      expect(toggle(`«${Y}${STOP}»${IDEOGRAPHIC_SPACE}${Z}`, format).doc.toString()).toBe(
        `${open}${Y}${STOP}${close}${IDEOGRAPHIC_SPACE}${Z}`,
      )
    }
  })

  it('leaves a selection of nothing but punctuation between letters as it is', () => {
    for (const format of FORMATS) {
      const s = state(`${X}«${STOP}»${Z}`)
      const done = apply(s, toggleInline(s, format))
      expect(done.doc.toString()).toBe(`${X}${STOP}${Z}`)
    }
  })

  it('toggles off again, the selection as it was left', async () => {
    for (const format of FORMATS) {
      const start = `${X}${X}«${Y}${Y}${STOP}»${Z}${Z}`
      const on = toggle(start, format)
      expect(isInlineActive(on, format)).toBe(true)
      // The same press again takes it off, not a second pair on.
      const off = apply(on, toggleInline(on, format))
      expect(off.doc.toString()).toBe(`${X}${X}${Y}${Y}${STOP}${Z}${Z}`)
      // And on again from there.
      expect(apply(off, toggleInline(off, format)).doc.toString()).toBe(on.doc.toString())
      // Selecting only the text inside the markers takes it off too.
      const inner = state(on.doc.toString().replace(Y + Y, `«${Y}${Y}»`))
      expect(apply(inner, toggleInline(inner, format)).doc.toString()).toBe(
        `${X}${X}${Y}${Y}${STOP}${Z}${Z}`,
      )
    }
  })

  it('does not tie the punctuation in the markers when a selection starts or ends in a span', () => {
    // Part of a bold span selected with the stop after it: nothing doubles.
    const s = state(`${X}**${Y}${Y}**«${STOP}»${Z}`)
    const done = apply(s, toggleInline(s, 'bold'))
    expect(done.doc.toString().match(/\*\*/g)?.length ?? 0).toBeLessThanOrEqual(2)
  })

  it('keeps escapes and other syntax at the edges where they are', async () => {
    // A star that is text is escaped inside the markers, so it is never moved out.
    expect(toggle('x«* y»z', 'bold').doc.toString()).toBe('x* yz')
    expect(toggle('x «* y»z', 'bold').doc.toString()).toBe('x **\\* y**z')
    // Italic text inside the selection keeps its own markers.
    const nested = toggle(`${X} «*${Y}*${STOP}»`, 'bold').doc.toString()
    expect(await previewTexts(nested, 'em')).toEqual([Y])
    expect(await previewTexts(nested, 'strong')).toEqual([`${Y}${STOP}`])
  })
})

describe('emphasis the editor writes parses the way the preview does', () => {
  // Random strings of letters, punctuation and spaces, each selection
  // formatted and unformatted: the result is read by both parsers.
  const ALPHABET = [
    'a',
    'b',
    ' ',
    '.',
    ',',
    '(',
    ')',
    '-',
    X,
    Y,
    STOP,
    COMMA,
    OPEN,
    CLOSE,
    QUOTE_OPEN,
    SMILE,
    IDEOGRAPHIC_SPACE,
  ]
  function random(seed: number) {
    let n = seed
    return () => {
      n = (n * 1664525 + 1013904223) % 4294967296
      return n / 4294967296
    }
  }

  it('reads as the format on the selected text, and toggles off', async () => {
    const next = random(7)
    const pick = () => ALPHABET[Math.floor(next() * ALPHABET.length)]!
    const kinds = [
      ['bold', 'StrongEmphasis', 'strong'],
      ['italic', 'Emphasis', 'em'],
      ['strikethrough', 'Strikethrough', 'del'],
    ] as const
    const squeeze = (text: string) => text.replace(/\s/g, '')
    const problems: string[] = []
    for (let round = 0; round < 150; round++) {
      const chars = Array.from({ length: 4 + Math.floor(next() * 8) }, pick)
      const from = Math.floor(next() * chars.length)
      const to = from + 1 + Math.floor(next() * (chars.length - from))
      const doc = chars.join('')
      const selection = chars.slice(from, to).join('')
      const marked = `${chars.slice(0, from).join('')}«${selection}»${chars.slice(to).join('')}`
      // The text the format can hold: the selection without edge punctuation and spaces.
      const core = selection.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')
      for (const [format, node, tag] of kinds) {
        const s = state(marked)
        const spec = toggleInline(s, format)
        const on = spec ? apply(s, spec) : s
        const after = on.doc.toString()
        const held = squeeze((await previewTexts(after, tag)).join(''))
        const spans: string[] = []
        noteParser.parse(after).iterate({
          enter(n) {
            if (n.name === node) spans.push(after.slice(n.from, n.to))
          },
        })
        const off = after === doc ? doc : apply(on, toggleInline(on, format)).doc.toString()
        // What went wrong, if anything. Markers that cannot parse are not
        // written (only punctuation selected); otherwise the format holds the
        // selected text, perhaps with punctuation that could stay inside,
        // the editor's parser finds the same spans, and the same key again
        // takes the format off.
        const wrong: string[] = []
        if (after === doc) {
          if (core !== '') wrong.push('gave up on text')
        } else {
          if (held === '') wrong.push('no format in the preview')
          if (!squeeze(selection).includes(held)) wrong.push('holds more than the selection')
          if (!held.includes(squeeze(core))) wrong.push('does not hold the text')
          if (spans.length !== (await previewTexts(after, tag)).length)
            wrong.push('the parsers disagree')
          if (off !== doc) wrong.push('does not toggle off')
        }
        problems.push(...wrong.map((what) => `${what}: ${marked} (${format}) -> ${after}`))
      }
    }
    expect(problems).toEqual([])
  })
})

describe('formats next to other inline syntax', () => {
  it('takes a format off text nested in other syntax without breaking it', () => {
    expect(inline('**a *«b»* c**', 'bold')).toBe('**a** *«b»* **c**')
    expect(inline('**a `«b»` c**', 'bold')).toBe('**a** `«b»` **c**')
    expect(inline('**a [«b»](u) c**', 'bold')).toBe('**a** [«b»](u) **c**')
    expect(inline('**a ~~«b»~~ c**', 'bold')).toBe('**a** ~~«b»~~ **c**')
  })

  it('toggles back and forth on nested text without piling up markers', () => {
    let s = state('**a *«b»* c**')
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      s = apply(s, toggleInline(s, 'bold'))
      seen.push(show(s))
      expect(isInlineActive(s, 'bold')).toBe(i % 2 === 1)
    }
    expect(seen[2]).toBe(seen[0])
    expect(seen[3]).toBe(seen[1])
    expect(s.doc.length).toBeLessThan(20)
  })

  it('widens a format over the whole of syntax the selection cuts through', () => {
    expect(inline('*a«b* c»d', 'bold')).toBe('***a«b* c»**d')
    expect(inline('`a«b` c»d', 'bold')).toBe('**`a«b` c»**d')
    expect(inline('`a«b»c`', 'italic')).toBe('*`a«b»c`*')
  })

  it('still formats inside emphasis and link text', () => {
    expect(inline('*a«b»c*', 'bold')).toBe('*a**«b»**c*')
    expect(inline('[a«b»c](u)', 'bold')).toBe('[a**«b»**c](u)')
  })
})

describe('inline shortcuts pressed twice at a cursor', () => {
  it.each<InlineFormat>(['bold', 'italic', 'strikethrough', 'highlight', 'code'])(
    '%s inserts a pair, then takes it out again',
    (format) => {
      let s = state('ab|')
      s = apply(s, toggleInline(s, format))
      expect(show(s)).not.toBe('ab|')
      s = apply(s, toggleInline(s, format))
      expect(show(s)).toBe('ab|')
    },
  )

  it('takes out only its own markers from an empty bold italic pair', () => {
    expect(inline('a ***|***', 'bold')).toBe('a *|*')
    expect(inline('a ***|***', 'italic')).toBe('a **|**')
    expect(inline('a **|**', 'italic')).toBe('a ***|***')
  })
})

describe('large notes', () => {
  // A whole long note selected: every lookup must reuse one syntax tree.
  const block =
    'Some **bold** and *italic* text with `code` and a [link](https://x.y) here.\n\n' +
    '- item one\n- [ ] task two\n\n```js\nconst a = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n'
  const big = () => {
    let doc = ''
    while (doc.length < 200_000) doc += block
    return EditorState.create({
      doc,
      selection: EditorSelection.single(0, doc.length),
      extensions: [noteMarkdown],
    })
  }

  it('formats a 200 KB selection quickly', { timeout: 30_000 }, (context) => {
    const s = big()
    const start = performance.now()
    const spec = toggleInline(s, 'bold')
    const ms = performance.now() - start
    // A command gives up (null) when its parse budget runs out.
    if (spec === null) skipIfOverloaded(context, 'parse budget ran out')
    expect(spec).not.toBeNull()
    expectWithinBudget(context, ms, 3000)
  })

  it('reads the toolbar state of a 200 KB selection quickly', { timeout: 30_000 }, (context) => {
    const s = big()
    // Parsed already (as the editor does in the background), so the state is read in full.
    ensureSyntaxTree(s, s.doc.length, 30_000)
    const start = performance.now()
    formatState(s)
    expectWithinBudget(context, performance.now() - start, 16)
  })
})

describe('toolbar state of a long selection', () => {
  const lines = (count: number) => Array.from({ length: count }, () => '- **bold text**').join('\n')
  const pressed = (marked: string) => {
    const s = state(marked)
    ensureSyntaxTree(s, s.doc.length, 30_000)
    return formatState(s)
  }

  it('shows the formats of a selection up to the line limit', () => {
    const on = pressed(`«${lines(TOOLBAR_MAX_LINES)}»`)
    expect(on).toMatchObject({ bold: true, bulletList: true, italic: false })
  })

  it('shows no format as pressed past the line limit, except the heading', () => {
    const past = pressed(`«${lines(TOOLBAR_MAX_LINES + 1)}»`)
    expect(Object.values(past).some(Boolean)).toBe(false)
    expect(pressed(`«# Title\n${lines(TOOLBAR_MAX_LINES + 1)}»`).heading).toBe(true)
  })

  it('counts the lines of all the ranges', () => {
    const half = lines(Math.ceil(TOOLBAR_MAX_LINES / 2) + 1)
    expect(pressed(`«${half}»\n\n«${half}»`).bold).toBe(false)
  })

  it('reads the longest selection it shows within a frame', (context) => {
    const s = state(`«${lines(TOOLBAR_MAX_LINES)}»`)
    ensureSyntaxTree(s, s.doc.length, 30_000)
    // Once before, as in an editor that has been used.
    formatState(state(`«${lines(TOOLBAR_MAX_LINES)}»`))
    const start = performance.now()
    const on = formatState(s)
    expectWithinBudget(context, performance.now() - start, 16)
    expect(on.bold).toBe(true)
  })
})

describe('inline formats on a long line with many spans', () => {
  const line = (count: number) =>
    Array.from({ length: count }, (_, i) => `**b${i}** x *i* \`c\``).join(' ')
  const whole = (count: number) => {
    const text = line(count)
    const s = EditorState.create({
      doc: text,
      selection: EditorSelection.single(0, text.length),
      extensions: [noteMarkdown],
    })
    ensureSyntaxTree(s, s.doc.length, 30_000)
    return s
  }

  it.for<InlineFormat>(['bold', 'italic', 'code'])(
    'toggles %s on 3000 spans in the time of a few keystrokes',
    (format, context) => {
      const s = whole(3000)
      const start = performance.now()
      const spec = toggleInline(s, format)
      const ms = performance.now() - start
      if (spec === null) skipIfOverloaded(context, 'parse budget ran out')
      expect(spec).not.toBeNull()
      expectWithinBudget(context, ms, 150)
    },
  )

  // What the formats made of such a line before the lookups were indexed.
  const units = (count: number, unit: (i: number) => string) =>
    Array.from({ length: count }, (_, i) => unit(i)).join(' ')
  const results: Record<InlineFormat, (count: number) => string> = {
    bold: (n) => `**${units(n, (i) => `b${i} x *i* \`c\``)}**`,
    italic: (n) => `*${units(n, (i) => `**b${i}** x i \`c\``)}*`,
    code: (n) => `\`${units(n, (i) => `**b${i}** x *i* c`)}\``,
    strikethrough: (n) => `~~${line(n)}~~`,
    highlight: (n) => `<mark>${line(n)}</mark>`,
  }

  it.for<[InlineFormat, number]>(
    (['bold', 'italic', 'code', 'strikethrough', 'highlight'] as const).flatMap((f) => [
      [f, 3] as [InlineFormat, number],
      [f, 600] as [InlineFormat, number],
    ]),
  )('makes the same text of %s on %i spans', ([format, count]) => {
    const s = whole(count)
    expect(apply(s, toggleInline(s, format)).doc.toString()).toBe(results[format](count))
  })

  it('takes a format off again', () => {
    const s = whole(40)
    const bolded = apply(s, toggleInline(s, 'bold'))
    expect(isInlineActive(bolded, 'bold')).toBe(true)
    const plain = apply(bolded, toggleInline(bolded, 'bold'))
    expect(isInlineActive(plain, 'bold')).toBe(false)
    expect(plain.doc.toString()).toBe(
      line(40)
        .replace(/\*\*(b\d+)\*\*/g, '$1')
        .replace(/^/, ''),
    )
  })
})

// Review fixes: every result is checked with the editor's parser (GFM and front matter).
const parse = (doc: string) => noteParser.parse(doc)

/** The block structure of a document: the names of its block nodes, in order. */
function blocksOf(doc: string): string[] {
  const names: string[] = []
  parse(doc).iterate({
    enter(node) {
      if (node.type.is('Block')) names.push(node.name)
    },
  })
  return names
}

/** Where nodes of a type are in a document, as `[from, to]` pairs. */
function nodesOf(doc: string, name: string): [number, number][] {
  const found: [number, number][] = []
  parse(doc).iterate({
    enter(node) {
      if (node.name === name) found.push([node.from, node.to])
    },
  })
  return found
}

describe('formats at a cursor never make block syntax', () => {
  const formats: InlineFormat[] = ['bold', 'italic', 'strikethrough', 'highlight', 'code']
  const docs = ['|', '- |', '> |', '|abc', '~|', '*|', '`|', '|~~x', '- [ ] |', '# |', 'a\n|']
  for (const format of formats)
    it.each(docs)(`${format} at %j keeps the blocks or does nothing`, (marked) => {
      const s = state(marked)
      const spec = toggleInline(s, format)
      if (spec === null) return
      const after = s.update(spec).state.doc.toString()
      // The same blocks as a typed letter would give.
      const at = s.selection.main.head
      const typed = s.doc.sliceString(0, at) + 'x' + s.doc.sliceString(at)
      expect(blocksOf(after)).toEqual(blocksOf(typed))
    })

  it('does nothing where the pair would open a fence or make a rule', () => {
    expect(toggleInline(state('|'), 'strikethrough')).toBeNull()
    expect(toggleInline(state('|'), 'bold')).toBeNull()
    expect(toggleInline(state('- |'), 'bold')).toBeNull()
    expect(toggleInline(state('|~~x'), 'strikethrough')).toBeNull()
  })

  it('still inserts a pair in the middle of text', () => {
    expect(inline('ab|c', 'strikethrough')).toBe('ab~~|~~c')
    expect(inline('|abc', 'bold')).toBe('**|**abc')
  })
})

describe('links next to other inline syntax', () => {
  const linkDoc = (marked: string) => {
    const s = state(marked)
    return docOf(s, toggleLink(s))
  }

  it('widens over a span the selection cuts through instead of splitting it', () => {
    const doc = linkDoc('**b«old** te»xt')
    expect(doc).toBe('[**bold** te]()xt')
    expect(nodesOf(doc, 'Link')).toEqual([[0, doc.indexOf('()') + 2]])
    expect(nodesOf(doc, 'StrongEmphasis')).toEqual([[1, 9]])
  })

  it('escapes brackets in the link text that would end it early', () => {
    const doc = linkDoc('a «x]y» b')
    expect(nodesOf(doc, 'Link')).toEqual([[2, doc.indexOf('()') + 2]])
    expect(doc.replace('\\', '')).toBe('a [x]y]() b')
    const open = linkDoc('«x[y»')
    expect(nodesOf(open, 'Link')).toEqual([[0, open.length]])
  })

  it('does nothing inside the text of an image', () => {
    expect(toggleLink(state('![al|t](x.png)'))).toBeNull()
    expect(toggleLink(state('![a«l»t](x.png)'))).toBeNull()
  })

  it('inserts nothing on a blank line of a code block', () => {
    expect(toggleLink(state('```\n|\n```'))).toBeNull()
    expect(toggleInline(state('```\n|\n```'), 'bold')).toBeNull()
    expect(setHeading(state('```\nx\n|\n```'), 1)).toBeNull()
    expect(toggleLink(state('~~~\nx\n|\n'))).toBeNull()
    // Outside it, a blank line takes an empty link.
    expect(show(apply(state('```\nx\n```\n|'), toggleLink(state('```\nx\n```\n|'))))).toBe(
      '```\nx\n```\n[|]()',
    )
  })

  it('links a whole image', () => {
    expect(linkDoc('«![alt](x.png)»')).toBe('[![alt](x.png)]()')
  })
})

describe('marker characters inside the formatted text', () => {
  it.each<[InlineFormat, string, string]>([
    ['italic', 'a*b', 'Emphasis'],
    ['italic', 'a* b', 'Emphasis'],
    ['bold', 'a* b', 'StrongEmphasis'],
    ['bold', 'a** b', 'StrongEmphasis'],
    ['strikethrough', 'a~~ b', 'Strikethrough'],
    ['bold', 'a\\', 'StrongEmphasis'],
  ])('%s on %j covers the whole selection', (format, text, node) => {
    const s = state(`«${text}»`)
    const doc = docOf(s, toggleInline(s, format))
    expect(nodesOf(doc, node)).toEqual([[0, doc.length]])
  })

  it('keeps a trailing backslash from escaping the closing tag', () => {
    const s = state('«a\\»')
    const doc = docOf(s, toggleInline(s, 'highlight'))
    expect(nodesOf(doc, 'HTMLTag').map(([from, to]) => doc.slice(from, to))).toEqual([
      '<mark>',
      '</mark>',
    ])
  })

  it('leaves the markers of other syntax unescaped', () => {
    expect(inline('«a *b* c»', 'bold')).toBe('**«a *b* c»**')
    expect(inline('«a `*` c»', 'italic')).toBe('*«a `*` c»*')
  })
})

describe('several ranges with a cursor among them', () => {
  it('leaves a cursor that already has the format alone when applying', () => {
    expect(inline('**a|b** «cd»', 'bold')).toBe('**a|b** **«cd»**')
  })
})

describe('setext headings', () => {
  const heading = (marked: string, level: number) => {
    const s = state(marked)
    return show(apply(s, setHeading(s, level)))
  }

  it('turns into an ATX heading without the underline', () => {
    expect(heading('Ti|tle\n===', 2)).toBe('## Ti|tle')
    expect(heading('Ti|tle\n---\nText', 3)).toBe('### Ti|tle\nText')
    expect(heading('«a\nb»\n===', 2)).toBe('«## a b»')
    const s = state('Ti|tle\n===')
    expect(show(apply(s, cycleHeading(s)))).toBe('## Ti|tle')
  })

  it('loses the heading and its underline when set to its own level', () => {
    expect(heading('Ti|tle\n===', 1)).toBe('Ti|tle')
    const kept = heading('Ti|tle\n---\nText', 2)
    expect(kept).toBe('Ti|tle\n\nText')
    expect(blocksOf(kept.replace('|', ''))).toEqual(['Document', 'Paragraph', 'Paragraph'])
  })

  it('shows as a heading', () => {
    expect(formatState(state('Ti|tle\n===')).heading).toBe(true)
    expect(formatState(state('Ti|tle\n---')).heading).toBe(true)
  })
})

/** A parser that makes no progress until it is told to stop, like one far behind. */
class StalledParser extends Parser {
  createParse(): PartialParse {
    const partial: PartialParse & { stoppedAt: number | null } = {
      parsedPos: 0,
      stoppedAt: null,
      stopAt: (pos) => {
        partial.stoppedAt = pos
      },
      advance: () =>
        partial.stoppedAt === null ? null : new Tree(NodeType.none, [], [], partial.stoppedAt),
    }
    return partial
  }
}

describe('notes the parser has not reached yet', () => {
  const stalled = new LanguageSupport(
    new Language(defineLanguageFacet(), new StalledParser(), [], 'stalled'),
  )

  it('refuses to format instead of reading them as plain text', { timeout: 10_000 }, () => {
    const s = state('```\n«code»\n```', [stalled])
    expect(toggleInline(s, 'bold')).toBeNull()
    expect(toggleLink(s)).toBeNull()
    expect(setHeading(s, 1)).toBeNull()
    const blocks: FormatId[] = ['codeBlock', 'bulletList', 'numberedList', 'taskList', 'quote']
    for (const id of [...blocks, 'alertNote' as const]) expect(FORMAT_COMMANDS[id](s)).toBeNull()
  })

  it('reads no toolbar state without blocking for long', (context) => {
    const s = state('**«a»**', [stalled])
    const start = performance.now()
    expect(Object.values(formatState(s)).some(Boolean)).toBe(false)
    expectWithinBudget(context, performance.now() - start, 200)
  })
})

describe('toolbar state cost', () => {
  it('splits the selection into segments once per state', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`)
    const s = state(`«${lines.join('\n')}»`)
    const spy = vi.spyOn(Tree.prototype, 'resolveInner')
    try {
      formatState(s)
      const first = spy.mock.calls.length
      expect(first).toBeLessThanOrEqual(lines.length + 5)
      toggleInline(s, 'bold')
      expect(spy.mock.calls.length - first).toBeLessThanOrEqual(2)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('formatCommand', () => {
  const run = (
    marked: string,
    id: FormatId,
    composition: { composing: boolean; compositionStarted: boolean } = {
      composing: false,
      compositionStarted: false,
    },
  ): [boolean, string] => {
    let s = state(marked)
    const view = {
      ...composition,
      get state() {
        return s
      },
      dispatch: (spec: TransactionSpec) => {
        s = s.update(spec).state
      },
    } as unknown as EditorView
    const handled = formatCommand(id)(view)
    return [handled, show(s)]
  }

  it('lets the key through when the format does nothing', () => {
    expect(run('```\nco|de\n```', 'italic')).toEqual([false, '```\nco|de\n```'])
    expect(run('a «b» c', 'bold')).toEqual([true, 'a **«b»** c'])
  })

  it('changes nothing while an input method composes', () => {
    // From compositionstart on, also before the composition changed any text.
    const started = { composing: false, compositionStarted: true }
    const composing = { composing: true, compositionStarted: true }
    expect(run('a «b» c', 'bold', started)).toEqual([false, 'a «b» c'])
    expect(run('a «b» c', 'heading1', composing)).toEqual([false, 'a «b» c'])
  })
})

describe('formats leave front matter alone', () => {
  const FRONT = '---\ntitle: Launch plan\ntags:\n  - work\n\n> not a quote\n---\n'
  const at = (marked: string) => `${FRONT}Body`.replace(marked.replace(/[«»|]/g, ''), marked)
  const inside = [
    `«${FRONT.slice(0, -1)}»\nBody`,
    at('«title: Launch plan»'),
    at('title: |Launch plan'),
    at('  - «work»'),
    at('|\n> not'),
    at('> «not a quote»'),
    at('---|\nBody'),
    `|${FRONT}Body`,
  ]
  const ids = Object.keys(FORMAT_COMMANDS) as FormatId[]

  it.each(ids)('%s does nothing inside front matter', (id) => {
    const results = inside.map((marked) => [marked, FORMAT_COMMANDS[id](state(marked))])
    expect(results).toEqual(inside.map((marked) => [marked, null]))
  })

  it.each<[FormatId, string]>([
    ['bold', '**Body**'],
    ['code', '`Body`'],
    ['link', '[Body]()'],
    ['heading1', '# Body'],
    ['heading', '# Body'],
    ['bulletList', '- Body'],
    ['numberedList', '1. Body'],
    ['taskList', '- [ ] Body'],
    ['quote', '> Body'],
    ['alertNote', '> [!NOTE]\n> Body'],
    ['codeBlock', '```\nBody\n```'],
  ])('%s formats only the text after the front matter', (id, body) => {
    const s = state(`«${FRONT}Body»`)
    expect(apply(s, FORMAT_COMMANDS[id](s)).doc.toString()).toBe(FRONT + body)
  })

  it('still treats a setext heading after the front matter as a heading', () => {
    const s = state(`${FRONT}«Title»\n---\n`)
    expect(formatState(s).heading).toBe(true)
    expect(apply(s, setHeading(s, 1)).doc.toString()).toBe(`${FRONT}# Title\n`)
  })

  it('shows no format as applied inside front matter', () => {
    const s = state(at('«title: Launch plan»'))
    expect(Object.values(formatState(s)).some(Boolean)).toBe(false)
  })
})
