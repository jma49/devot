// HTML import: an HTML file becomes Markdown before it imports as a Markdown file does (import.ts). The page is sanitized first (the default GitHub-style schema: no
// scripts, styles, event handlers, comments, frames or `javascript:`/`data:` URLs), then converted, so the note holds no raw HTML. Local images stay relative links
// (import turns them into attachments); remote ones stay links. Before that:
// - An image embedded as a `data:` URI (as Export as HTML and page savers write them) is taken out to be stored as an attachment, and its link points at it
//   (`devot://file/<id>`). A lazy-loaded image's `data-src` wins over the placeholder in its `src`.
// - MathML that carries its TeX source (an `application/x-tex` annotation) becomes math again; a KaTeX page's HTML drawing of it is left out.
// - Whatever else holds content the note cannot keep (SVG, other MathML, frames, objects, media, other `data:` and local-file URLs) is listed in `dropped`.

import type { Element, ElementContent, Nodes, Root } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { defaultSchema, sanitize, type Schema } from 'hast-util-sanitize'
import { toMdast } from 'hast-util-to-mdast'
import type { Nodes as MdNodes, PhrasingContent, Root as MdRoot, RootContent } from 'mdast'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { mathToMarkdown } from 'mdast-util-math'
import { toMarkdown } from 'mdast-util-to-markdown'
import { detectImage, fileUri } from './files'

const STRIP = [
  'script',
  'style',
  'template',
  'noscript',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
]

const SCHEMA: Schema = { ...defaultSchema, strip: STRIP }

/** Media and canvas are unwrapped by the sanitizer, so their fallback content is still looked at. */
const DROPPED = new Set(['svg', 'math', 'iframe', 'object', 'embed', 'video', 'audio', 'canvas'])

/** Whatever type it names: its bytes decide whether import stores it as an attachment (`detectImage`). */
const BASE64_URL = /^data:[^,]*;base64,([\s\S]*)$/i

const KEPT_SRC = /^https?:/i

export const MAX_DROPPED = 100

export interface HtmlImage {
  id: string
  mime: string
  data: Uint8Array
}

export interface HtmlConversion {
  title: string | null
  markdown: string
  images: HtmlImage[]
  /**
   * Each once, in order: an element as `<name>` (`<svg>`), a `data:` URL by its type (`data:image/bmp`), any other image URL as written. At most
   * `MAX_DROPPED` of them, then `+N` for the rest.
   */
  dropped: string[]
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

const classes = (node: Element) => {
  const value = node.properties['className']
  return Array.isArray(value) ? value.map(String) : []
}

const stringProperty = (node: Element, name: string) => {
  const value = node.properties[name]
  return typeof value === 'string' ? value : null
}

function texOf(math: Element): string | null {
  const walk = (node: Nodes): string | null => {
    if (node.type === 'element' && node.tagName === 'annotation') {
      const encoding = stringProperty(node, 'encoding')?.trim().toLowerCase()
      if (encoding === 'application/x-tex') return textOf(node).trim() || null
    }
    if (!('children' in node)) return null
    for (const child of node.children) {
      const found = walk(child as Nodes)
      if (found !== null) return found
    }
    return null
  }
  return walk(math)
}

function hasTexMath(node: Element): boolean {
  return node.children.some(
    (c) => c.type === 'element' && (c.tagName === 'math' ? texOf(c) !== null : hasTexMath(c)),
  )
}

const dataLabel = (url: string) =>
  'data:' + (/^data:([^;,]*)/i.exec(url)?.[1] ?? '').toLowerCase().slice(0, 100)

/** Null when the text is not base64. */
function base64Bytes(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text.replace(/[\t\n\f\r ]/g, '')), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

function contentOf(node: Nodes): string {
  const parts: string[] = []
  const walk = (n: Nodes) => {
    if (n.type === 'text' || n.type === 'comment') parts.push(n.value)
    if (n.type === 'element') {
      for (const value of Object.values(n.properties)) parts.push(String(value))
    }
    if ('children' in n) for (const child of n.children) walk(child as Nodes)
  }
  walk(node)
  return parts.join('\n').toLowerCase()
}

const nonce = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
    String.fromCharCode(97 + (b % 26)),
  ).join('')

/** A marker no page holds, so placeholders built on it survive the sanitizer. */
function markerFor(page: Nodes): string {
  const content = contentOf(page)
  let marker: string
  do marker = `devotimport${nonce()}`
  while (content.includes(marker))
  return marker
}

/** Nothing here reads positions, and copying them is much of what sanitizing and converting cost. */
function dropPositions(node: Nodes): void {
  delete node.position
  if ('children' in node) for (const child of node.children) dropPositions(child as Nodes)
}

function capped(dropped: Set<string>): string[] {
  const all = [...dropped]
  if (all.length <= MAX_DROPPED) return all
  return [...all.slice(0, MAX_DROPPED), `+${all.length - MAX_DROPPED}`]
}

interface Prepared {
  images: HtmlImage[]
  imageIds: string[]
  math: { tex: string; display: boolean }[]
  dropped: Set<string>
}

/** Takes out of `root` (before it is sanitized) what the sanitizer would lose: embedded images and MathML with TeX become placeholders. */
function prepare(root: Root, marker: string, newId?: () => string): Prepared {
  const out: Prepared = { images: [], imageIds: [], math: [], dropped: new Set() }
  const drop = (label: string) => out.dropped.add(label)
  // The same embedded image twice is one attachment.
  const embedded = new Map<string, number>()
  const keepImage = (node: Element): boolean => {
    let src = stringProperty(node, 'src')
    const lazy = stringProperty(node, 'dataSrc')?.trim()
    if (lazy && (!src || /^\s*data:/i.test(src))) src = lazy
    if (src === null) return true
    node.properties['src'] = src
    const url = src.trim()
    if (!/^data:/i.test(url)) {
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url) || KEPT_SRC.test(url)) return true
      drop(url.slice(0, 200))
      return false
    }
    const known = embedded.get(url)
    if (known !== undefined) {
      node.properties['src'] = `${marker}i${known}`
      return true
    }
    const match = BASE64_URL.exec(url)
    const data = match ? base64Bytes(match[1]!) : null
    const mime = data ? detectImage(data) : null
    if (!newId || !data || !mime) {
      drop(dataLabel(url))
      return false
    }
    const id = newId()
    const index = out.imageIds.push(id) - 1
    out.images.push({ id, mime, data })
    embedded.set(url, index)
    node.properties['src'] = `${marker}i${index}`
    return true
  }
  const walk = (parent: Root | Element) => {
    parent.children = parent.children.flatMap((child): ElementContent[] => {
      if (child.type !== 'element') return child.type === 'doctype' ? [] : [child]
      // A KaTeX page draws its math as HTML beside the MathML: once that
      // MathML's TeX is restored, the drawing is no text of the note.
      if (classes(child).includes('katex') && hasTexMath(child)) {
        child.children = child.children.filter(
          (c) => !(c.type === 'element' && classes(c).includes('katex-html')),
        )
      }
      if (child.tagName === 'math') {
        const tex = texOf(child)
        if (tex !== null) {
          const index = out.math.push({ tex, display: child.properties['display'] === 'block' }) - 1
          return [{ type: 'text', value: `${marker}m${index}e` }]
        }
      }
      if (DROPPED.has(child.tagName)) drop(`<${child.tagName}>`)
      // Gone with its content: nothing in it is the page's to keep.
      if (STRIP.includes(child.tagName)) return [child]
      if (child.tagName === 'img' && !keepImage(child)) return []
      const href = child.tagName === 'a' ? stringProperty(child, 'href') : null
      if (href !== null && /^\s*data:/i.test(href)) drop(dataLabel(href.trim()))
      walk(child)
      return [child]
    })
  }
  walk(root)
  return out
}

/** Returns the IDs of the images linked. */
function restore(tree: MdRoot, marker: string, prepared: Prepared): Set<string> {
  const linked = new Set<string>()
  const imageAt = new RegExp(`^${marker}i(\\d+)$`)
  const mathAt = new RegExp(`${marker}m(\\d+)e`, 'g')
  const mathAlone = new RegExp(`^\\s*${marker}m(\\d+)e\\s*$`)
  // A placeholder `prepare` did not make (the page cannot spell the
  // marker, but nothing breaks if it did) stays as written.
  const mathOf = (index: string) => prepared.math[Number(index)]
  const phrasing = (value: string): PhrasingContent[] => {
    const parts = value.split(mathAt)
    const out: PhrasingContent[] = []
    let pending = ''
    parts.forEach((part, i) => {
      const math = i % 2 === 1 ? mathOf(part) : undefined
      if (i % 2 === 0) pending += part
      else if (!math) pending += `${marker}m${part}e`
      else {
        if (pending) out.push({ type: 'text', value: pending })
        pending = ''
        out.push({ type: 'inlineMath', value: math.tex })
      }
    })
    if (pending) out.push({ type: 'text', value: pending })
    return out
  }
  // In code (and alt text), math is its TeX source as text.
  const plain = (value: string) =>
    value.replace(mathAt, (whole, index: string) => mathOf(index)?.tex ?? whole)
  const walk = (node: MdNodes) => {
    if ((node.type === 'code' || node.type === 'inlineCode') && node.value.includes(marker)) {
      node.value = plain(node.value)
    }
    if (node.type === 'image' && node.alt?.includes(marker)) node.alt = plain(node.alt)
    if (node.type === 'image') {
      const at = imageAt.exec(node.url)
      const id = at ? prepared.imageIds[Number(at[1])] : undefined
      if (id !== undefined) {
        node.url = fileUri(id)
        linked.add(id)
      }
    }
    if (!('children' in node)) return
    const children = node.children as MdNodes[]
    const next: MdNodes[] = []
    for (const child of children) {
      if (child.type === 'text' && child.value.includes(marker)) {
        next.push(...phrasing(child.value))
        continue
      }
      // Display math alone in its paragraph is a math block.
      if (child.type === 'paragraph') {
        const only = child.children.filter((c) => !(c.type === 'text' && c.value.trim() === ''))
        const one = only.length === 1 ? only[0] : undefined
        const match = one?.type === 'text' ? mathAlone.exec(one.value) : null
        const math = match ? mathOf(match[1]!) : undefined
        if (math?.display) {
          next.push({ type: 'math', value: math.tex })
          continue
        }
      }
      walk(child)
      next.push(child)
    }
    ;(node as { children: MdNodes[] }).children = next
  }
  walk(tree)
  return linked
}

/** Embedded images take their IDs from `newId`; without it they are left out. */
export function htmlToMarkdown(html: string, newId?: () => string): HtmlConversion {
  const page = fromHtml(html)
  // The page's own title is in its head; an SVG `<title>` in the body is not it.
  const head = find(page, 'head')
  const named = head ? find(head, 'title') : null
  const title = named ? textOf(named).replace(/\s+/g, ' ').trim() || null : null
  const body = find(page, 'body')
  const root: Root = { type: 'root', children: body ? body.children : [] }
  dropPositions(root)
  const marker = markerFor(page)
  const prepared = prepare(root, marker, newId)
  // A frameset page has no body: its frames are other pages.
  if (!body && find(page, 'frameset')) prepared.dropped.add('<frameset>')
  const clean = sanitize(root, SCHEMA)
  const tree = toMdast(clean) as MdRoot
  const linked = restore(tree, marker, prepared)
  const markdown = toMarkdown(tree as RootContent | MdRoot, {
    extensions: [gfmToMarkdown(), mathToMarkdown()],
    bullet: '-',
    // `***`, never `---`: a note starting with `---` could read as front matter.
    rule: '*',
    fences: true,
    emphasis: '*',
    strong: '*',
    listItemIndent: 'one',
  })
  // Only images the Markdown links are attachments; one whose link went in
  // the conversion is listed as left out.
  const images = prepared.images.filter((image) => linked.has(image.id))
  for (const image of prepared.images) {
    if (!linked.has(image.id)) prepared.dropped.add(`data:${image.mime}`)
  }
  return {
    title,
    markdown: markdown.trim() === '' ? '' : markdown,
    images,
    dropped: capped(prepared.dropped),
  }
}
