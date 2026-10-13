import type { Element, Root, RootContent } from 'hast'
import { renderPreview, type PreviewLabels } from '../../src/core'

// What the preview makes of Markdown, as a flat description for assertions:
// editor tests use it to check that text the editor writes reads as intended
// by the parser the preview, export and print use.

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

/** The preview's tree for some Markdown. */
export const previewTree = (markdown: string): Promise<Root> =>
  renderPreview(markdown, { labels, loadedEmbeds: [] })

const textOf = (node: Root | RootContent): string => {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map(textOf).join('') : ''
}

/**
 * The preview as markup without attributes: elements as `<tag>…</tag>`,
 * text as it is, whitespace between blocks left out.
 */
export function previewShape(markdown: string): Promise<string> {
  const show = (node: Root | RootContent): string => {
    if (node.type === 'text') return node.value
    if (node.type !== 'element' && node.type !== 'root') return ''
    const inner = node.children.map(show).join('')
    return node.type === 'root' ? inner : `<${node.tagName}>${inner}</${node.tagName}>`
  }
  return previewTree(markdown).then((tree) => show(tree).replace(/\n/g, ''))
}

/** The text of each element with this tag, in order. */
export async function previewTexts(markdown: string, tag: string): Promise<string[]> {
  const found: string[] = []
  const walk = (node: Root | RootContent) => {
    if (node.type === 'element' && (node as Element).tagName === tag) found.push(textOf(node))
    if ('children' in node) node.children.forEach(walk)
  }
  walk(await previewTree(markdown))
  return found
}
