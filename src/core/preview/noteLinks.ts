// Note link chips. A link to `devot://note/<id>` whose text is empty or the
// target's title shows the target as a chip: its status, title, task
// progress and tags. A link to a note that is gone gets a broken-link icon.
// It only runs when the caller says which notes exist (`noteLinks`), so
// exported pages keep plain links. Every value it shows goes in as text.
import type { Element, ElementContent, Root, RootContent } from 'hast'
import { glyph } from './glyphs'
import { PREVIEW_API_VERSION, type NoteLinkTarget, type PreviewRenderer } from './registry'

const NOTE_HREF = /^devot:\/\/note\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

function textOf(node: RootContent | Root): string {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map(textOf).join('') : ''
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

const span = (className: string, children: ElementContent[]): Element => ({
  type: 'element',
  tagName: 'span',
  properties: { className: [className] },
  children,
})

const txt = (value: string): ElementContent => ({ type: 'text', value })

function chip(target: NoteLinkTarget, untitled: string): ElementContent[] {
  const out: ElementContent[] = []
  if (target.status !== 'none') {
    out.push(glyph(target.status, `note-chip-status note-chip-status-${target.status}`))
  }
  out.push(span('note-chip-title', [txt(target.title || untitled)]))
  if (target.tasks.total > 0) {
    out.push({
      type: 'element',
      tagName: 'progress',
      properties: {
        className: ['task-bar'],
        value: String(target.tasks.done),
        max: String(target.tasks.total),
      },
      children: [],
    })
  }
  for (const tag of target.tags) {
    const colour = tag.color ? [`tag-color-${tag.color}`] : []
    out.push({
      type: 'element',
      tagName: 'span',
      properties: { className: ['note-chip-tag', ...colour] },
      children: [txt(tag.name)],
    })
  }
  return out
}

function wantsChip(link: Element, target: NoteLinkTarget): boolean {
  if (link.children.some((c) => c.type === 'element')) return false
  const text = squash(textOf(link))
  return text === '' || text === squash(target.title)
}

function visit(
  node: Root | Element,
  targets: Readonly<Record<string, NoteLinkTarget>>,
  labels: { untitled: string; missingNote: string },
): void {
  for (const child of node.children) {
    if (child.type !== 'element') continue
    const href = child.tagName === 'a' ? child.properties['href'] : undefined
    const id = typeof href === 'string' ? NOTE_HREF.exec(href)?.[1] : undefined
    if (!id) {
      visit(child, targets, labels)
      continue
    }
    const target = Object.hasOwn(targets, id) ? targets[id] : undefined
    const classes = Array.isArray(child.properties['className'])
      ? child.properties['className'].map(String)
      : []
    if (!target) {
      child.properties['className'] = [...classes, 'note-link-missing']
      child.properties['title'] = labels.missingNote
      child.children = [glyph('broken-link', 'note-link-broken'), ...child.children]
    } else if (wantsChip(child, target)) {
      child.properties['className'] = [...classes, 'note-chip']
      child.children = chip(target, labels.untitled)
    }
  }
}

export const noteLinkChips: PreviewRenderer = {
  id: 'devot.note-links',
  apiVersion: PREVIEW_API_VERSION,
  transform(tree, { noteLinks, labels }) {
    if (noteLinks) visit(tree, noteLinks, labels)
  },
}
