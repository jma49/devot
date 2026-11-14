import type { Element, Root, RootContent } from 'hast'
import { describe, expect, it } from 'vitest'
import {
  MAX_NOTE_EMBEDS,
  noteEmbed,
  noteEmbeds,
  renderPreview,
  renderPreviewPieces,
  type NoteLinkTarget,
  type PreviewLabels,
} from '../../src/core'
import { embeddedBody, MAX_EMBED_CHARS } from '../../src/core/notes/links'

const labels: PreviewLabels = {
  alerts: {
    note: 'Note',
    tip: 'Tip',
    important: 'Important',
    warning: 'Warning',
    caution: 'Caution',
  },
  embedFrom: 'Embedded content from {origin}',
  embedLoad: 'Load',
  videoTitle: 'Embedded video',
  untitled: 'Untitled',
  missingNote: 'Note not found',
  codeLines: 'Lines {start} to {end}',
  codeLine: 'Line {n}',
  codeRef: 'in {ref}',
  codeSource: 'Open source',
}

const A = '0192a6f0-0000-7000-8000-00000000000a'
const B = '0192a6f0-0000-7000-8000-00000000000b'
const C = '0192a6f0-0000-7000-8000-00000000000c'

const target = (
  markdown: string | undefined,
  over: Partial<NoteLinkTarget> = {},
): NoteLinkTarget => ({
  title: 'Groceries',
  status: 'none',
  tasks: { done: 0, total: 0 },
  tags: [],
  ...(markdown === undefined ? {} : { embed: { markdown, clipped: false } }),
  ...over,
})

const render = (md: string, noteLinks?: Record<string, NoteLinkTarget>) =>
  renderPreview(md, { labels, loadedEmbeds: [], ...(noteLinks ? { noteLinks } : {}) })

function all(tree: Root | Element, test: (el: Element) => boolean): Element[] {
  const out: Element[] = []
  const walk = (node: Root | RootContent) => {
    if (node.type === 'element' && test(node)) out.push(node)
    if ('children' in node) node.children.forEach(walk)
  }
  walk(tree)
  return out
}

const classes = (el: Element) =>
  ((el.properties['className'] as string[] | undefined) ?? []).map(String)
const byClass = (tree: Root | Element, name: string) =>
  all(tree, (el) => classes(el).includes(name))
const text = (node: Root | RootContent): string =>
  node.type === 'text' ? node.value : 'children' in node ? node.children.map(text).join('') : ''

describe('noteEmbeds', () => {
  it('finds the notes embedded with image syntax, not the ones only linked', () => {
    const md = `${noteEmbed('One', A)} [two](devot://note/${B}) ![x \\] y](devot://note/${C})`
    expect(noteEmbeds(md)).toEqual([A, C])
  })

  it('keeps at most MAX_NOTE_EMBEDS', () => {
    const ids = Array.from(
      { length: MAX_NOTE_EMBEDS + 5 },
      (_, i) => `0192a6f0-0000-7000-8000-${String(i).padStart(12, '0')}`,
    )
    expect(noteEmbeds(ids.map((id) => noteEmbed('n', id)).join('\n\n'))).toHaveLength(
      MAX_NOTE_EMBEDS,
    )
  })
})

describe('embeddedBody', () => {
  it('drops the front matter and keeps a short body whole', () => {
    expect(embeddedBody('---\ntitle: x\n---\n\nHello')).toEqual({
      markdown: 'Hello',
      clipped: false,
    })
  })

  it('cuts a long body at a line break within the limit', () => {
    const line = `${'a'.repeat(99)}\n`
    const { markdown, clipped } = embeddedBody(line.repeat(MAX_EMBED_CHARS / 50))
    expect(clipped).toBe(true)
    expect(markdown.length).toBeLessThanOrEqual(MAX_EMBED_CHARS)
    expect(markdown.endsWith('a')).toBe(true)
  })
})

describe('note embeds in the preview', () => {
  it("shows an embed alone in a paragraph as the note's body under a chip that opens it", async () => {
    const tree = await render(`Before\n\n${noteEmbed('Groceries', A)}\n\nAfter`, {
      [A]: target('# Milk\n\n- eggs'),
    })
    const [embed] = byClass(tree, 'note-embed')
    expect(embed?.properties['dataNoteEmbed']).toBe(A)
    const [title] = byClass(embed!, 'note-embed-title')
    expect(title?.properties['href']).toBe(`devot://note/${A}`)
    expect(classes(title!)).toContain('note-chip')
    const [body] = byClass(embed!, 'note-embed-body')
    expect(all(body!, (el) => el.tagName === 'h1').map(text)).toEqual(['Milk'])
    expect(all(body!, (el) => el.tagName === 'li').map(text)).toEqual(['eggs'])
    // The embed takes the paragraph's place, with its source line.
    expect(all(tree, (el) => el.tagName === 'p').map(text)).toEqual(['Before', 'After'])
    expect(typeof embed?.properties['dataSourceLine']).toBe('number')
  })

  it('leaves the embedded body read-only and without anything that points into the host note', async () => {
    const tree = await render(noteEmbed('Groceries', A), {
      [A]: target(
        '- [ ] buy\n\n## Part\n\n![](devot://file/0192a6f0-0000-7000-8000-0000000000f1)\n\nSee[^1]\n\n[^1]: a note',
      ),
    })
    const [body] = byClass(tree, 'note-embed-body')
    const [box] = all(body!, (el) => el.tagName === 'input')
    expect(box?.properties['disabled']).toBe(true)
    const marked = all(body!, (el) =>
      ['dataTaskAt', 'dataImageFrom', 'dataImageTo', 'dataSourceLine', 'id'].some(
        (key) => el.properties[key] !== undefined,
      ),
    )
    expect(marked).toEqual([])
    expect(all(body!, (el) => el.properties['dataFootnotes'] !== undefined)).toEqual([])
    expect(all(body!, (el) => el.properties['dataFootnoteRef'] !== undefined)).toEqual([])
  })

  it('shows a note the embedded note embeds or links as a plain link, never as missing', async () => {
    const tree = await render(noteEmbed('Groceries', A), {
      [A]: target(`${noteEmbed('Back', B)}\n\nand [c](devot://note/${C})`),
    })
    const [body] = byClass(tree, 'note-embed-body')
    expect(byClass(body!, 'note-embed')).toEqual([])
    const hrefs = all(body!, (el) => el.tagName === 'a').map((a) => a.properties['href'])
    expect(hrefs).toEqual([`devot://note/${B}`, `devot://note/${C}`])
    expect(byClass(body!, 'note-link-missing')).toEqual([])
  })

  it('marks a clipped body', async () => {
    const tree = await render(noteEmbed('Groceries', A), {
      [A]: { ...target(undefined), embed: { markdown: 'start', clipped: true } },
    })
    expect(classes(byClass(tree, 'note-embed')[0]!)).toContain('note-embed-clipped')
  })

  it('shows an embed inside text, one without its body, or one on an exported page as a link', async () => {
    const inline = await render(`See ${noteEmbed('Groceries', A)} here`, { [A]: target('body') })
    const noBody = await render(noteEmbed('Groceries', A), { [A]: target(undefined) })
    const exported = await render(noteEmbed('Groceries', A))
    for (const tree of [inline, noBody, exported]) {
      expect(byClass(tree, 'note-embed')).toEqual([])
      expect(all(tree, (el) => el.tagName === 'img')).toEqual([])
      expect(all(tree, (el) => el.tagName === 'a').map((a) => a.properties['href'])).toEqual([
        `devot://note/${A}`,
      ])
    }
    expect(classes(byClass(noBody, 'note-chip')[0]!)).toContain('note-chip')
  })

  it('shows an embed of a missing note as a broken link', async () => {
    const tree = await render(noteEmbed('Gone', B), { [A]: target('body') })
    expect(byClass(tree, 'note-link-missing')).toHaveLength(1)
  })

  it('renders the piece again when the embedded body changes', async () => {
    const md = `Intro\n\n${noteEmbed('Groceries', A)}`
    const first = await renderPreviewPieces(md, {
      labels,
      loadedEmbeds: [],
      noteLinks: { [A]: target('one') },
    })
    const again = await renderPreviewPieces(
      md,
      { labels, loadedEmbeds: [], noteLinks: { [A]: target('two') } },
      first.map((p) => p.key),
    )
    expect(again.some((piece) => piece.nodes !== undefined)).toBe(true)
  })
})
