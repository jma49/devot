import { EditorState, Text } from '@codemirror/state'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import { randomChange, randomNote, seeded } from '../../../../../tests/support/random-notes'
import { definitionsIn } from '../../../../core/preview/definitions'
import { carryFootnotes, footnoteNumbers, linkDefinitions } from './footnotes'

const numbers = (doc: string) => Object.fromEntries(footnoteNumbers(Text.of(doc.split('\n'))))
const links = (doc: string) => [...linkDefinitions(Text.of(doc.split('\n')))].sort()
const preview = unified().use(remarkParse).use(remarkGfm)
const previewLinks = (doc: string) => [...definitionsIn(preview.parse(doc)).links.keys()].sort()

describe('footnote numbers', () => {
  it('count a label with a definition, in the order of its first reference, those in definitions last', () => {
    const doc = 'See[^b] and[^a].\n\n[^a]: First[^c].\n[^b]: Second.\n[^c]: Third.\n\nNone[^x].'
    expect(numbers(doc)).toEqual({ b: 1, a: 2, c: 3 })
  })

  it('leave out references in code and escaped ones', () => {
    const doc = '`[^a]` \\[^a]\n\n```\n[^a]\n```\n\n    [^a]\n\nThen[^b].\n\n[^a]: A.\n[^b]: B.'
    expect(numbers(doc)).toEqual({ b: 1 })
  })

  it('count the references on a line that only looks like a link definition', () => {
    for (const line of ['[TODO]: see this[^1]', '- [x]: done, see[^1]', '[a]: /url "t"[^1]'])
      expect(numbers(`${line}\n\n[^1]: The note.`)).toEqual({ 1: 1 })
    expect(numbers('[a]: /url[^1]\n\n[^1]: The note.')).toEqual({})
  })
})

describe('link definitions', () => {
  it('are the labels defined outside code, case folded and spaced as the preview matches them', () => {
    const doc =
      '    [d]: /d\n\n[A  b]: https://a.example\n> [q]: /q\n\\[e]: /e\n[]: /x\n[^f]: Note.\n\n```\n[c]: /c\n```\n\n[\u00a0]: /n'
    expect(links(doc)).toEqual(['A B', 'Q', '\u00a0'])
  })

  it('are those the preview finds, a line that only looks like one left out', () => {
    for (const doc of [
      '[TODO]: buy milk',
      '[Note]: remember to call\n\nsee [note] here',
      'Some text\n[b]: /u',
      '- item\n[b]: /u',
      '> a\n[b]: /u',
      '> a\n> [b]: /u',
      '[b]: /u "t" junk',
      '[b]: /u "t"x',
      '[b]:',
      '[b]:\n\n/u',
      '[b]:\n==',
      '[b]: /u "multi\n\nline"',
      '[b]: /a(b',
      '[a]: /u (ti(t)le)',
      '[ ]: /u',
      '[^1]: Note\n[b]: /u',
      '[b]: /u\n===\n[c]: /c',
      '[b]: /u\n"title" ok\n[c]: /c',
      '[b]:\n/u "t" x',
    ])
      expect({ doc, links: links(doc) }).toEqual({ doc, links: previewLinks(doc) })
  })

  it('are those the preview finds over more than one line and after a block', () => {
    for (const doc of [
      '[b]:\n/u',
      '[a]: /a\n[b]: /b',
      '# H\n[b]: /b',
      'Title\n---\n[b]: /u',
      'a\n***\n[b]: /u',
      'a\n> [b]: /u',
      '- a\n- [b]: /u',
      '> a\n>\n> [b]: /u',
      '[^1]:\n[b]: /u',
      '[b]: /u "multi\nline"',
      '[b]: /u\n"multi\nline"\n[c]: /c',
      '[b]:\n/u\n"t" x',
      '[b]: /u\n> "t"',
      '[b]: <a b>',
      '[b]: /a((b))',
      "[b]: /u't'",
      '[^a b]: /u',
    ])
      expect({ doc, links: links(doc) }).toEqual({ doc, links: previewLinks(doc) })
  })
})

describe('footnote numbers after an edit', () => {
  it('are those a reading of the whole note finds, edit after edit', () => {
    const next = seeded(5)
    for (let note = 0; note < 60; note++) {
      let state = EditorState.create({ doc: randomNote(next) })
      footnoteNumbers(state.doc)
      for (let i = 0; i < 20; i++) {
        const tr = state.update({ changes: randomChange(next, state.doc.toString()) })
        carryFootnotes(tr)
        state = tr.state
        const doc = state.doc.toString()
        expect({
          doc,
          numbers: Object.fromEntries(footnoteNumbers(state.doc)),
          links: [...linkDefinitions(state.doc)].sort(),
        }).toEqual({ doc, numbers: numbers(doc), links: links(doc) })
      }
    }
  })

  it('are read again only from the edited line until the reading is as before', () => {
    const doc = Array.from({ length: 2000 }, (_, i) => `Line ${i}[^n]`).join('\n') + '\n\n[^n]: N.'
    const state = EditorState.create({ doc })
    const before = footnoteNumbers(state.doc)
    const tr = state.update({ changes: { from: 3, insert: 'x' } })
    carryFootnotes(tr)
    expect(footnoteNumbers(tr.state.doc)).toBe(before)
    const fenced = tr.state.update({ changes: { from: 0, insert: '```\n' } })
    carryFootnotes(fenced)
    expect(Object.fromEntries(footnoteNumbers(fenced.state.doc))).toEqual({})
  })
})
