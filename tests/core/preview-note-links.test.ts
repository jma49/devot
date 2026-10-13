import type { Element, Root, RootContent } from 'hast'
import { describe, expect, it } from 'vitest'
import { renderPreview, type NoteLinkTarget, type PreviewLabels } from '../../src/core'

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
}

const A = '0192a6f0-0000-7000-8000-00000000000a'
const B = '0192a6f0-0000-7000-8000-00000000000b'
const GONE = '0192a6f0-0000-7000-8000-00000000000c'

const target = (over: Partial<NoteLinkTarget> = {}): NoteLinkTarget => ({
  title: 'Groceries',
  status: 'none',
  tasks: { done: 0, total: 0 },
  tags: [],
  ...over,
})

function links(tree: Root | Element): Element[] {
  const out: Element[] = []
  const walk = (node: Root | RootContent) => {
    if (node.type === 'element' && node.tagName === 'a') out.push(node)
    if ('children' in node) node.children.forEach(walk)
  }
  walk(tree)
  return out
}

const classes = (el: Element) => (el.properties['className'] as string[] | undefined) ?? []
const text = (node: Root | RootContent): string =>
  node.type === 'text' ? node.value : 'children' in node ? node.children.map(text).join('') : ''
const kids = (el: Element, tagName: string) =>
  el.children.filter((c): c is Element => c.type === 'element' && c.tagName === tagName)

const render = (md: string, noteLinks?: Record<string, NoteLinkTarget>) =>
  renderPreview(md, {
    labels,
    loadedEmbeds: [],
    ...(noteLinks ? { noteLinks } : {}),
  })

describe('note link chips', () => {
  it('shows a link whose text is the title as a chip with status, progress and tags', async () => {
    const tree = await render(`[Groceries](devot://note/${A})`, {
      [A]: target({
        status: 'active',
        tasks: { done: 1, total: 2 },
        tags: [{ name: 'home', color: 'green' }],
      }),
    })
    const [link] = links(tree)
    expect(classes(link!)).toContain('note-chip')
    expect(kids(link!, 'svg')).toHaveLength(1)
    const [bar] = kids(link!, 'progress')
    expect(bar?.properties).toMatchObject({ value: '1', max: '2' })
    const spans = kids(link!, 'span')
    expect(spans.map(text)).toEqual(['Groceries', 'home'])
    expect(classes(spans[1]!)).toEqual(['note-chip-tag', 'tag-color-green'])
  })

  it('shows an empty link as a chip, naming an untitled note', async () => {
    const tree = await render(`[](devot://note/${A})`, {
      [A]: target({ title: '' }),
    })
    const [link] = links(tree)
    expect(classes(link!)).toContain('note-chip')
    expect(text(link!)).toBe('Untitled')
    expect(kids(link!, 'svg')).toHaveLength(0)
    expect(kids(link!, 'progress')).toHaveLength(0)
  })

  it('keeps other text as a plain link', async () => {
    const tree = await render(`[see this](devot://note/${A})`, {
      [A]: target(),
    })
    const [link] = links(tree)
    expect(classes(link!)).not.toContain('note-chip')
    expect(text(link!)).toBe('see this')
  })

  it('marks a link to a missing note with the broken-link icon', async () => {
    const tree = await render(`[Old](devot://note/${GONE}) [Groceries](devot://note/${B})`, {
      [B]: target(),
    })
    const [gone, kept] = links(tree)
    expect(classes(gone!)).toContain('note-link-missing')
    expect(gone!.properties['title']).toBe('Note not found')
    const [icon] = kids(gone!, 'svg')
    expect(classes(icon!)).toContain('note-link-broken')
    expect(text(gone!)).toBe('Old')
    expect(classes(kept!)).toContain('note-chip')
  })

  it('leaves note links alone without targets (exported pages)', async () => {
    const tree = await render(`[Groceries](devot://note/${A})`)
    const [link] = links(tree)
    expect(classes(link!)).toEqual([])
    expect(text(link!)).toBe('Groceries')
  })

  it('puts a title into the tree as text only', async () => {
    const tree = await render(`[](devot://note/${A})`, {
      [A]: target({ title: '<img src=x onerror=alert(1)>' }),
    })
    const [link] = links(tree)
    expect(kids(link!, 'span')[0]?.children).toEqual([
      { type: 'text', value: '<img src=x onerror=alert(1)>' },
    ])
  })
})
