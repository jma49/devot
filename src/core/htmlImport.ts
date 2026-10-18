// HTML import: an HTML file becomes Markdown before it imports as a Markdown
// file does (import.ts). The page is sanitized first (the default
// GitHub-style schema: no scripts, styles, event handlers, comments, frames
// or `javascript:`/`data:` URLs), then converted, so the note holds only
// Markdown and no raw HTML. Local images stay relative links, which import
// turns into attachments; remote ones stay links.

import type { Element, Nodes, Root } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { defaultSchema, sanitize, type Schema } from 'hast-util-sanitize'
import { toMdast } from 'hast-util-to-mdast'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { toMarkdown } from 'mdast-util-to-markdown'

const SCHEMA: Schema = {
  ...defaultSchema,
  // Dropped with their content, not only their tags.
  strip: ['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math'],
}

function textOf(node: Nodes): string {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map((c) => textOf(c as Nodes)).join('') : ''
}

function find(node: Nodes, tag: string): Element | null {
  if (node.type === 'element' && node.tagName === tag) return node
  if (!('children' in node)) return null
  for (const child of node.children) {
    const found = find(child as Nodes, tag)
    if (found) return found
  }
  return null
}

/**
 * An HTML page as Markdown, and its `<title>` (spaces tidied; null when it
 * has none or it is blank).
 */
export function htmlToMarkdown(html: string): { title: string | null; markdown: string } {
  const page = fromHtml(html)
  // The page's own title is in its head; an SVG `<title>` in the body is not it.
  const head = find(page, 'head')
  const named = head ? find(head, 'title') : null
  const title = named ? textOf(named).replace(/\s+/g, ' ').trim() || null : null
  const body = find(page, 'body')
  const root: Root = { type: 'root', children: body ? body.children : [] }
  const clean = sanitize(root, SCHEMA)
  const markdown = toMarkdown(toMdast(clean), {
    extensions: [gfmToMarkdown()],
    bullet: '-',
    // `***`, never `---`: a note starting with `---` could read as front matter.
    rule: '*',
    fences: true,
    emphasis: '*',
    strong: '*',
    listItemIndent: 'one',
  })
  return { title, markdown: markdown.trim() === '' ? '' : markdown }
}
