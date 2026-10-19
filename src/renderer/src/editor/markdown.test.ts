import { markdownLanguage } from '@codemirror/lang-markdown'
import { LanguageDescription, ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { EditorState } from '@codemirror/state'
import { TreeFragment, type ChangedRange, type PartialParse, type Tree } from '@lezer/common'
import { highlightTree, tags } from '@lezer/highlight'
import { MarkdownParser } from '@lezer/markdown'
import { describe, expect, it } from 'vitest'
import { frontMatter } from '../../../core/import'
import { light } from '../theme/tokens'
import {
  FRONT_MATTER,
  frontMatterTags,
  markupTags,
  noteHighlightStyle,
  noteMarkdown,
  noteParser,
} from './markdown'

function blocksOf(tree: Tree): string[] {
  const names: string[] = []
  tree.iterate({
    enter(node) {
      if (node.type.is('Block') && !node.type.isTop) names.push(node.name)
    },
  })
  return names
}

function namesOf(tree: Tree): Set<string> {
  const names = new Set<string>()
  tree.iterate({ enter: (node) => void names.add(node.name) })
  return names
}

const blocks = (doc: string) => blocksOf(noteParser.parse(doc))

function frontMatterOf(tree: Tree): [number, number] | null {
  const first = tree.topNode.firstChild
  return first?.name === FRONT_MATTER ? [first.from, first.to] : null
}

const NOTE = '---\ntitle: Launch plan\nauthor: me\n---\n\nBody text'

describe('front matter in the editor parser', () => {
  it('extends the same Lezer Markdown as the editor language', () => {
    // The extension finds its parse by class: a second copy of the package would turn it off.
    expect(markdownLanguage.parser).toBeInstanceOf(MarkdownParser)
    expect(noteMarkdown.language.parser.parse(NOTE).topNode.firstChild?.name).toBe(FRONT_MATTER)
  })

  it('reads a leading block as front matter, not as a setext heading', () => {
    const tree = noteParser.parse(NOTE)
    expect(blocksOf(tree)).toEqual([FRONT_MATTER, 'Paragraph'])
    expect(namesOf(tree).has('SetextHeading2')).toBe(false)
    expect(frontMatterOf(tree)).toEqual([0, NOTE.indexOf('\n\nBody')])
    const marks = tree.topNode.firstChild?.getChildren('FrontMatterMark') ?? []
    expect(marks.map((m) => NOTE.slice(m.from, m.to))).toEqual(['---', '---'])
    expect(marks.map((m) => m.from)).toEqual([0, NOTE.indexOf('---', 3)])
    // The plain GFM parser read the same text as a heading: the bug this fixes.
    expect(namesOf(markdownLanguage.parser.parse(NOTE)).has('SetextHeading2')).toBe(true)
  })

  it('does not parse Markdown inside the front matter', () => {
    const doc = '---\n# not a heading\n- item\n**bold** `code`\n> quote\n```\n---\n# Heading'
    const tree = noteParser.parse(doc)
    expect(blocksOf(tree)).toEqual([FRONT_MATTER, 'ATXHeading1'])
    const names = namesOf(tree)
    for (const name of ['BulletList', 'StrongEmphasis', 'InlineCode', 'Blockquote', 'FencedCode'])
      expect(names.has(name)).toBe(false)
  })

  it('keeps a later --- a thematic break or a setext underline', () => {
    expect(blocks('---\na: b\n---\n\nTitle\n---\n\n---\n')).toEqual([
      FRONT_MATTER,
      'SetextHeading2',
      'HorizontalRule',
    ])
    for (const doc of ['Intro\n\n---\na: b\n---\n', 'Title\n---\n\n---\n', '\n---\na\n---'])
      expect(blocks(doc)).toEqual(blocksOf(markdownLanguage.parser.parse(doc)))
  })

  it.each([
    ['basic', '---\na: b\n---\ntext'],
    ['spaces after the fences', '--- \na: b\n---\t\ntext'],
    ['empty', '---\n---\ntext'],
    ['empty, at the end', '---\n---'],
    ['at the end', '---\na: b\n---'],
    ['blank lines inside', '---\na: b\n\nc: d\n---\n'],
    ['a longer rule inside', '---\na: b\n----\n---\n'],
    ['text after dashes inside', '---\na: b\n---text\n---\n'],
    ['a code fence inside', '---\na: |\n  ```\n---\nafter'],
    ['closed by dots', '---\na: b\n...\ntext'],
    ['four dashes', '----\na: b\n----\n'],
    ['an indented fence', ' ---\na: b\n---\n'],
    ['an indented closing fence', '---\na: b\n ---\n'],
    ['a blank line first', '\n---\na: b\n---\n'],
    ['never closed', '---\na: b\ntext'],
    ['a rule alone', '---'],
    ['a rule and a line', '---\n'],
    ['in a quote', '> ---\n> a: b\n> ---\n'],
  ])('finds front matter where the preview does: %s', (_name, doc) => {
    const tree = noteParser.parse(doc)
    const found = frontMatterOf(tree)
    const yaml = frontMatter(doc)
    const inner = found && doc.slice(doc.indexOf('\n') + 1, found[1])
    const content = inner === null ? null : inner.slice(0, Math.max(0, inner.lastIndexOf('\n')))
    expect(content).toBe(yaml)
  })
})

describe('front matter while editing', () => {
  const parsed = (doc: string) => {
    const state = EditorState.create({ doc, extensions: [noteMarkdown] })
    // No time limit: a busy machine may pause the parse.
    expect(ensureSyntaxTree(state, state.doc.length, 1e9)).not.toBeNull()
    return state
  }
  const edit = (state: EditorState, from: number, to: number, insert = '') => {
    const next = state.update({ changes: { from, to, insert } }).state
    expect(ensureSyntaxTree(next, next.doc.length, 1e9)).not.toBeNull()
    return next
  }
  const first = (state: EditorState) => syntaxTree(state).topNode.firstChild?.name

  it('becomes front matter once the closing fence is typed, far below', () => {
    const body = Array.from({ length: 200 }, (_, i) => `Paragraph ${i}\n`).join('\n')
    let state = parsed(`---\ntitle: x\n\n${body}`)
    expect(first(state)).toBe('HorizontalRule')
    state = edit(state, state.doc.length, state.doc.length, '\n---\n')
    expect(first(state)).toBe(FRONT_MATTER)
    expect(syntaxTree(state).topNode.firstChild?.to).toBe(state.doc.length - 1)
  })

  it('becomes front matter once the closing fence is typed under the keys', () => {
    let state = parsed('---\ntitle: x\nauthor: me\n\nBody')
    expect(first(state)).toBe('HorizontalRule')
    let at = '---\ntitle: x\nauthor: me\n'.length
    for (const ch of '---\n') state = edit(state, at, at++, ch)
    expect(state.doc.toString()).toBe('---\ntitle: x\nauthor: me\n---\n\nBody')
    expect(first(state)).toBe(FRONT_MATTER)
  })

  it('becomes front matter once a closing fence is typed in the middle', () => {
    const body = Array.from({ length: 200 }, (_, i) => `Paragraph ${i}\n`).join('\n')
    let state = parsed(`---\ntitle: x\n\n${body}`)
    const at = state.doc.toString().indexOf('Paragraph 100')
    state = edit(state, at, at, '---\n')
    expect(syntaxTree(state).topNode.firstChild?.name).toBe(FRONT_MATTER)
    expect(syntaxTree(state).topNode.firstChild?.to).toBe(at + 3)
  })

  it('keeps reusing the parse of a note that starts with a rule it never closes', () => {
    const body = Array.from({ length: 200 }, (_, i) => `Paragraph ${i}\n`).join('\n')
    const doc = `---\n\n${body}`
    const { parser } = noteMarkdown.language
    const count = (parse: PartialParse) => {
      let n = 1
      while (!parse.advance()) n++
      return n
    }
    const steps = (at: number, insert: string) => {
      const ranges: ChangedRange[] = [{ fromA: at, toA: at, fromB: at, toB: at + insert.length }]
      const fragments = TreeFragment.applyChanges(TreeFragment.addTree(parser.parse(doc)), ranges)
      return count(parser.startParse(doc.slice(0, at) + insert + doc.slice(at), fragments))
    }
    const fresh = count(parser.startParse(doc))
    expect(fresh).toBeGreaterThan(200)
    const middle = doc.indexOf('Paragraph 100')
    expect(steps(doc.length, 'x')).toBeLessThan(20)
    expect(steps(middle, 'y')).toBeLessThan(20)
    // A typed fence closes front matter instead (the tests above).
  })

  it('stops being front matter when its closing fence goes', () => {
    let state = parsed(NOTE)
    expect(first(state)).toBe(FRONT_MATTER)
    const close = NOTE.indexOf('---', 3)
    state = edit(state, close - 1, close + 3)
    expect(first(state)).toBe('HorizontalRule')
    expect(blocksOf(syntaxTree(state))).toEqual(
      blocksOf(markdownLanguage.parser.parse(state.doc.toString())),
    )
  })

  it('stays front matter while its keys and the text below change', () => {
    let state = parsed(NOTE)
    state = edit(state, 4, 4, 'draft: true\n')
    expect(first(state)).toBe(FRONT_MATTER)
    state = edit(state, state.doc.length, state.doc.length, '\n\nMore\n---\n')
    expect(blocksOf(syntaxTree(state))).toEqual([FRONT_MATTER, 'Paragraph', 'SetextHeading2'])
  })
})

describe('front matter highlighting', () => {
  function classes(doc: string): string[] {
    const out: string[] = Array.from({ length: doc.length }, () => '')
    highlightTree(noteParser.parse(doc), noteHighlightStyle, (from, to, cls) => {
      for (let i = from; i < to; i++) out[i] = cls
    })
    return out
  }

  it('styles front matter as metadata, not as a heading', () => {
    const at = classes(NOTE)
    const heading = noteHighlightStyle.style([tags.heading2])
    const meta = noteHighlightStyle.style([frontMatterTags.content])
    const mark = noteHighlightStyle.style([frontMatterTags.mark])
    expect(meta).toBeTruthy()
    expect(mark).toBeTruthy()
    for (const i of [NOTE.indexOf('title'), NOTE.indexOf('author')]) expect(at[i]).toBe(meta)
    expect(at[0]).toBe(mark)
    expect(at[NOTE.indexOf('---', 3)]).toBe(mark)
    expect(at).not.toContain(heading)
  })

  it('still styles headings and other Markdown', () => {
    const doc = 'Title\n---\n\n**b**'
    const at = classes(doc)
    expect(at[0]).toBe(noteHighlightStyle.style([tags.heading2]))
    expect(at[doc.indexOf('b*')]).toBe(noteHighlightStyle.style([tags.strong]))
  })
})

describe('the editor highlight style', () => {
  const specs = noteHighlightStyle.specs as readonly { tag: unknown; [css: string]: unknown }[]

  it('takes every colour from a design token that exists', () => {
    const colours = specs.flatMap((spec) =>
      typeof spec['color'] === 'string' ? [spec['color']] : [],
    )
    expect(colours.length).toBeGreaterThan(8)
    const unknown = colours.filter((colour) => {
      const name = /^var\(--color-([a-z-]+)\)$/.exec(colour)?.[1]
      return !name || !Object.keys(light).includes(`color.${name.replace(/^([a-z]+)-/, '$1.')}`)
    })
    expect(unknown).toEqual([])
  })

  it('underlines links but not headings, so a heading or a table header does not look like one', () => {
    const decoration = (tag: Parameters<typeof noteHighlightStyle.style>[0][number]) => {
      const cls = noteHighlightStyle.style([tag])
      return specs.find((s) => noteHighlightStyle.style([s.tag as typeof tag]) === cls)?.[
        'textDecoration'
      ]
    }
    expect(decoration(tags.heading)).toBeUndefined()
    expect(decoration(tags.heading1)).toBeUndefined()
    expect(decoration(tags.link)).toBe('underline')
  })

  it('colours links, their addresses and rules', () => {
    const doc = '[site](https://example.com/a) and [n](devot://note/x)\n\n---\n'
    const at: string[] = Array.from({ length: doc.length }, () => '')
    highlightTree(noteParser.parse(doc), noteHighlightStyle, (from, to, cls) => {
      for (let i = from; i < to; i++) at[i] = cls
    })
    const plain = ['https://', 'devot://', '---'].filter((needle) => !at[doc.indexOf(needle)])
    expect(plain).toEqual([])
  })
})

describe('front matter is not Markdown to the editor', () => {
  it('turns the Markdown helpers off inside front matter', () => {
    const doc = '---\nsource: https://old.example\n---\n\nBody'
    const state = EditorState.create({ doc, extensions: [noteMarkdown] })
    expect(ensureSyntaxTree(state, doc.length, 1e9)).not.toBeNull()
    const key = doc.indexOf('old')
    const body = doc.indexOf('Body')
    // Pasting a URL as a link, list continuation and HTML tag completion
    // all ask whether Markdown is active at the cursor.
    expect(markdownLanguage.isActiveAt(state, key, 1)).toBe(false)
    expect(markdownLanguage.isActiveAt(state, key, -1)).toBe(false)
    expect(markdownLanguage.isActiveAt(state, body, 1)).toBe(true)
    expect(state.languageDataAt('autocomplete', key)).toEqual([])
    expect(state.languageDataAt('autocomplete', body)).toHaveLength(1)
  })
})

describe('Markdown source highlighting', () => {
  function classes(doc: string): string[] {
    const state = EditorState.create({ doc, extensions: [noteMarkdown] })
    const tree = ensureSyntaxTree(state, doc.length, 1e9)
    if (!tree) throw new Error('E_TEST_NO_TREE')
    const out: string[] = Array.from({ length: doc.length }, () => '')
    highlightTree(tree, noteHighlightStyle, (from, to, cls) => {
      for (let i = from; i < to; i++) out[i] = cls
    })
    return out
  }
  type HighlightTag = Parameters<typeof noteHighlightStyle.style>[0][number]
  const style = (tag: HighlightTag) => noteHighlightStyle.style([tag])
  const has = (cls: string | undefined, tag: HighlightTag) =>
    (cls ?? '').split(' ').includes(style(tag) ?? '\u0000')

  it('colours heading marks apart from the heading text', () => {
    const at = classes('### Free Mode\n')
    expect(has(at[0], markupTags.heading)).toBe(true)
    expect(has(at[4], tags.heading3)).toBe(true)
    expect(has(at[4], markupTags.heading)).toBe(false)
  })

  it('colours emphasis marks, inline code, HTML tags, list and quote markers', () => {
    const doc = 'Press <kbd>Cmd</kbd> to _go_ with `x`\n\n- item\n\n> quote\n'
    const at = classes(doc)
    expect(has(at[doc.indexOf('kbd')], tags.tagName)).toBe(true)
    expect(has(at[doc.indexOf('_go')], tags.processingInstruction)).toBe(true)
    expect(has(at[doc.indexOf('go_')], tags.emphasis)).toBe(true)
    expect(has(at[doc.indexOf('x`')], tags.monospace)).toBe(true)
    expect(has(at[doc.indexOf('- item')], markupTags.list)).toBe(true)
    expect(has(at[doc.indexOf('> quote')], markupTags.quote)).toBe(true)
    expect(has(at[doc.indexOf('quote\n')], tags.quote)).toBe(true)
    for (const tag of [
      markupTags.heading,
      markupTags.list,
      markupTags.quote,
      tags.tagName,
      tags.monospace,
    ])
      expect(style(tag)).toBeTruthy()
  })

  it('underlines link addresses', () => {
    const at = classes('![shot](https://example.com/a.png)\n')
    const specs = noteHighlightStyle.specs as readonly { tag: unknown; [css: string]: unknown }[]
    expect(specs.find((s) => s.tag === tags.url)?.['textDecoration']).toBe('underline')
    expect(has(at[8], tags.url)).toBe(true)
  })

  it('highlights a fenced block in its own language', async () => {
    await LanguageDescription.matchLanguageName(languages, 'js')?.load()
    const doc = '```js\nconst a = "s"\n```\n'
    const at = classes(doc)
    expect(has(at[doc.indexOf('const')], tags.keyword)).toBe(true)
    expect(has(at[doc.indexOf('"s"')], tags.string)).toBe(true)
  })
})
