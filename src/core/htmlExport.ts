// HTML export, Copy as HTML and printing: a note's preview (the sanitized tree `renderPreview` gives) as a page of its own. No scripts: what the preview's page adds
// itself becomes plain markup.
//
// Rules:
// - Images of attachments (`devot://file/<id>`) get a placeholder token in their `src` (`devot-image-<nonce>-<n>`); Rust puts the bytes in as `data:` URIs
//   (src-tauri/src/export.rs), so the page stands alone. The preview already moved an image's size preset (`#half`) to a class (`image-size-half`).
// - A page to print (Print... and Export as PDF...) loads nothing from the web, so no slow host holds a print job up: each web image becomes a link to it (its alt text,
//   else its URL, as the text); a `picture`'s other sources are left out. An exported page keeps them as images.
// - Islands (Mermaid diagrams) take the SVG the UI drew, cleaned again here (no scripts, foreign objects, event handlers, links out, or `<` in its CSS, which could end
//   the style element); without one, the diagram's source shows as a code block.
// - A link within the note (`#x`) points at the prefixed id the preview gives its target (`#user-content-x`), so it jumps on the page too.
// - Video embeds and embeds that load on a click become links. Colour swatches get their colour as an inline style. `data-*` attributes are left out.
// - Simple HTML (Copy as Simple HTML) also leaves out every class and style, heading ids, front matter, swatches, code block headers and highlighting, and diagram
//   drawings; alerts become block quotes with a bold title. A sized image gets no `width` either (Half has no pixel width to give).

import type { Element, ElementContent, Properties, Root, RootContent } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { toHtml } from 'hast-util-to-html'
import { FILE_URL } from './export'
import { fragmentId } from './preview/headingIds'

export interface PageImage {
  placeholder: string
  fileId: string
}

export interface PageOptions {
  nonce: string
  simple?: boolean
  island?: (kind: string, source: string) => string | null
  noteHref?: (noteId: string) => string | null
  print?: boolean
}

export interface PageBody {
  html: string
  images: PageImage[]
}

const NOTE_URL = /^devot:\/\/note\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
const NONCE = /^[0-9a-f]{32}$/
const WEB_URL = /^https?:/i
const HEADING = /^h[1-6]$/

const DROPPED_SVG = new Set(['script', 'foreignObject', 'iframe', 'image', 'use'])

const el = (tagName: string, properties: Properties, children: ElementContent[] = []): Element => ({
  type: 'element',
  tagName,
  properties,
  children,
})

const txt = (value: string): ElementContent => ({ type: 'text', value })

const classes = (node: Element): string[] => {
  const value = node.properties['className']
  return Array.isArray(value) ? value.map(String) : []
}

const codeBlock = (language: string, source: string): Element =>
  el('pre', {}, [el('code', { className: [`language-${language}`] }, [txt(source)])])

const textOf = (node: ElementContent): string =>
  node.type === 'text' ? node.value : 'children' in node ? node.children.map(textOf).join('') : ''

const link = (href: string): Element => el('p', {}, [el('a', { href }, [txt(href)])])

function drawing(markup: string): Element | null {
  const tree = fromHtml(markup, { fragment: true })
  const svg = tree.children.find((c): c is Element => c.type === 'element')
  if (svg?.tagName !== 'svg') return null
  const clean = (node: Element): Element => {
    const properties: Properties = {}
    for (const [key, value] of Object.entries(node.properties)) {
      if (/^on/i.test(key)) continue
      if (/^(?:href|xLinkHref)$/.test(key) && !String(value).startsWith('#')) continue
      properties[key] = value
    }
    const children = node.children.flatMap((child): ElementContent[] => {
      // A style element's text is written out as it is, so a `<` in it
      // (`</style>` in a diagram's CSS) would end it: CSS reads `\3c ` as `<`.
      if (child.type === 'text' && node.tagName === 'style') {
        return [{ ...child, value: child.value.replace(/</g, '\\3c ') }]
      }
      if (child.type === 'text') return [child]
      if (child.type !== 'element' || DROPPED_SVG.has(child.tagName)) return []
      return [clean(child)]
    })
    return { ...node, properties, children }
  }
  return clean(svg)
}

export function pageBody(tree: Root, options: PageOptions): PageBody {
  if (!NONCE.test(options.nonce)) throw new Error('E_EXPORT_NONCE_INVALID')
  const simple = options.simple ?? false
  const placeholders = new Map<string, string>()
  const placeholder = (fileId: string) => {
    let token = placeholders.get(fileId)
    if (token === undefined) {
      token = `devot-image-${options.nonce}-${placeholders.size}`
      placeholders.set(fileId, token)
    }
    return token
  }

  const print = options.print ?? false
  const convert = (node: RootContent, inLink = false): RootContent[] => {
    if (node.type !== 'element') return node.type === 'text' ? [node] : []
    const names = classes(node)
    const kind = node.properties['dataDevotIsland']
    if (typeof kind === 'string') {
      const source = String(node.properties['dataIslandSource'] ?? '')
      const markup = simple ? null : (options.island?.(kind, source) ?? null)
      const svg = markup === null ? null : drawing(markup)
      return svg
        ? [el('div', { className: ['island', `island-${kind}`] }, [svg])]
        : convert(codeBlock(kind, source))
    }
    if (names.includes('embed-video') || names.includes('embed-frame')) {
      const frame = names.includes('embed-frame')
        ? node
        : node.children.find((c): c is Element => c.type === 'element')
      const src = frame?.properties['src']
      return typeof src === 'string' ? [link(src)] : []
    }
    if (names.includes('embed-placeholder')) {
      const src = node.properties['dataEmbedSrc']
      return typeof src === 'string' ? [link(src)] : []
    }
    if (print && node.tagName === 'img') {
      const src = node.properties['src']
      if (typeof src === 'string' && WEB_URL.test(src)) {
        const alt = node.properties['alt']
        const text = txt(typeof alt === 'string' && alt.trim() !== '' ? alt : src)
        return inLink ? [text] : [el('a', { href: src }, [text])]
      }
    }
    if (print && node.tagName === 'source') return []
    if (simple && (names.includes('frontmatter') || names.includes('swatch'))) return []
    if (simple && names.includes('code-block')) {
      // The code alone: no header, no line numbers, no highlighting.
      const pre = node.children.find(
        (c): c is Element => c.type === 'element' && c.tagName === 'pre',
      )
      const code = pre?.children.find(
        (c): c is Element => c.type === 'element' && c.tagName === 'code',
      )
      return code ? [el('pre', {}, [el('code', {}, [txt(textOf(code))])])] : []
    }
    // Icons are drawings; simple HTML keeps the words.
    if (simple && names.includes('glyph')) return []
    if (simple && names.includes('alert')) {
      const [title, ...rest] = node.children
      const words = (parent: Element) =>
        parent.children.filter((c) => !(c.type === 'element' && classes(c).includes('glyph')))
      const heading =
        title?.type === 'element' && classes(title).includes('alert-title')
          ? [el('p', {}, [el('strong', {}, words(title))])]
          : title
            ? [title]
            : []
      return convert(el('blockquote', {}, [...heading, ...rest]))
    }

    const properties: Properties = {}
    for (const [key, value] of Object.entries(node.properties)) {
      if (/^data[A-Z]/.test(key)) continue
      if (simple && (key === 'className' || key === 'style')) continue
      if (simple && key === 'id' && HEADING.test(node.tagName)) continue
      properties[key] = value
    }
    // A task's box can be ticked in the preview only.
    if (node.tagName === 'input') properties['disabled'] = true
    if (node.tagName === 'img') {
      const id = FILE_URL.exec(String(node.properties['src'] ?? ''))?.[1]
      if (id) properties['src'] = placeholder(id)
    }
    if (node.tagName === 'a') {
      const id = NOTE_URL.exec(String(node.properties['href'] ?? ''))?.[1]
      const href = id === undefined ? null : (options.noteHref?.(id) ?? null)
      if (href !== null) properties['href'] = href
      const fragment = /^#(.+)$/s.exec(String(node.properties['href'] ?? ''))?.[1]
      if (fragment !== undefined) properties['href'] = `#${fragmentId(fragment)}`
    }
    if (names.includes('swatch')) {
      const color = node.properties['dataSwatchColor']
      // The colour passed the swatch renderer's check; CSS.supports is the page's.
      if (typeof color === 'string') properties['style'] = `background-color: ${color}`
    }
    const inside = inLink || node.tagName === 'a'
    const children = node.children.flatMap((child) => convert(child, inside) as ElementContent[])
    return [{ ...node, properties, children }]
  }

  const root: Root = { type: 'root', children: tree.children.flatMap((node) => convert(node)) }
  return {
    html: toHtml(root),
    images: [...placeholders].map(([fileId, token]) => ({ placeholder: token, fileId })),
  }
}

const escapeText = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const PAGE_CSP = "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'"

export const PRINT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'"

/** `print`: a page to print, under PRINT_CSP. */
export function htmlDocument(page: {
  title: string
  body: string
  css: string
  lang: string
  print?: boolean
}): string {
  const csp = page.print ? PRINT_CSP : PAGE_CSP
  return [
    '<!doctype html>',
    `<html lang="${escapeText(page.lang).replace(/"/g, '&quot;')}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="generator" content="Devot">',
    `<title>${escapeText(page.title)}</title>`,
    // `</style` cannot appear inside the style element.
    `<style>${page.css.replace(/<\/style/gi, '<\\/style')}</style>`,
    '</head>',
    '<body>',
    `<article class="preview">${page.body}</article>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}
