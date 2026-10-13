// Built-in preview renderers. They run on the sanitized tree and only build
// structure from validated values.
import type { Element, ElementContent, Properties, Root, RootContent } from 'hast'
import { createEmojiRenderer } from './emoji'
import {
  parseImageMarkdown,
  presetOf,
  sizeAttribute,
  splitAltSize,
  splitImageSize,
} from '../images'
import { createMathRenderer } from './math'
import { PREVIEW_API_VERSION, type AlertKind, type PreviewRenderer } from './registry'
import { fillPlaceholders } from '../text'
import { createCodeRenderer } from './code'
import { glyph } from './glyphs'
import { noteLinkChips } from './noteLinks'
import { parse, stringify } from 'yaml'

type Parent = Root | Element
/** `undefined` keeps the element (and visits its children); `null` removes it. */
type Rewrite = (el: Element, parent: Parent) => ElementContent | ElementContent[] | null | undefined

/**
 * Rewrites elements depth-first; a replaced element's subtree is not visited.
 * A replacement takes the replaced element's place in the source (its
 * position), so the preview still knows which line it comes from.
 */
function rewrite(node: Parent, fn: Rewrite): void {
  const out: RootContent[] = []
  for (const child of node.children) {
    if (child.type !== 'element') {
      out.push(child)
      continue
    }
    const next = fn(child, node)
    if (next === undefined) {
      rewrite(child, fn)
      out.push(child)
    } else if (next !== null) {
      const list = Array.isArray(next) ? next : [next]
      const lead = list[0]
      if (lead && lead !== child && !lead.position && child.position) lead.position = child.position
      out.push(...list)
    }
  }
  node.children = out as typeof node.children
}

const el = (tagName: string, properties: Properties, children: ElementContent[] = []): Element => ({
  type: 'element',
  tagName,
  properties,
  children,
})

const txt = (value: string): ElementContent => ({ type: 'text', value })

function textOf(node: RootContent | Root): string {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map(textOf).join('') : ''
}

const isBlank = (node: RootContent) => node.type === 'text' && node.value.trim() === ''

// --- Front matter ----------------------------------------------------------

/** A front matter value as text: scalars as written, anything else as YAML. */
function valueText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && !(value instanceof Date)) return stringify(value).trimEnd()
  return value instanceof Date ? value.toISOString() : String(value)
}

/** The rows of a properties block, or null when the YAML is not a plain map. */
function propertiesBlock(yaml: string): Element | null {
  let data: unknown
  try {
    data = parse(yaml, { maxAliasCount: 16 })
  } catch {
    return null
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const rows = Object.entries(data as Record<string, unknown>).map(([key, value]) => {
    const list = Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object')
    const dd = list
      ? (value as unknown[]).map((v) =>
          el('span', { className: ['frontmatter-chip'] }, [txt(valueText(v))]),
        )
      : [txt(valueText(value))]
    return el('div', { className: ['frontmatter-row'] }, [
      el('dt', {}, [txt(key)]),
      el('dd', {}, dd),
    ])
  })
  return rows.length > 0 ? el('dl', { className: ['frontmatter'] }, rows) : null
}

/**
 * Front matter shows as a compact block of properties (key and value per
 * row, lists as chips); YAML that is not a map of keys shows as code.
 */
const frontmatter: PreviewRenderer = {
  id: 'devot.frontmatter',
  apiVersion: PREVIEW_API_VERSION,
  transform(tree, { frontmatter: yaml }) {
    if (yaml === null) return
    const block =
      propertiesBlock(yaml) ??
      el('pre', { className: ['frontmatter'] }, [
        el('code', { className: ['language-yaml'] }, [txt(yaml)]),
      ])
    // Front matter always opens the note.
    block.position = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }
    tree.children.unshift(block)
  },
}

// --- Alerts ------------------------------------------------------------------

const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i

const alerts: PreviewRenderer = {
  id: 'devot.alerts',
  apiVersion: PREVIEW_API_VERSION,
  transform(tree, { labels }) {
    rewrite(tree, (quote) => {
      if (quote.tagName !== 'blockquote') return undefined
      const first = quote.children.find((c): c is Element => c.type === 'element')
      const lead = first?.tagName === 'p' ? first.children[0] : undefined
      const match = lead?.type === 'text' ? ALERT.exec(lead.value) : null
      if (!first || !lead || lead.type !== 'text' || !match?.[1]) return undefined
      const kind = match[1].toLowerCase() as AlertKind
      lead.value = lead.value.slice(match[0].length)
      if (lead.value === '') first.children.shift()
      if (first.children[0]?.type === 'element' && first.children[0].tagName === 'br') {
        first.children.shift()
      }
      const emptyLead = first.children.every(isBlank)
      const body = quote.children.filter((c) => !(emptyLead && c === first))
      return el('div', { className: ['alert', `alert-${kind}`] }, [
        el('p', { className: ['alert-title'] }, [
          glyph(kind, 'alert-icon'),
          txt(labels.alerts[kind]),
        ]),
        ...body,
      ])
    })
  },
}

// --- Task lists ----------------------------------------------------------------

const TASK = /^(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\]/

/**
 * A task's checkbox gets where its mark (the space or `x` between the
 * brackets) is in the Markdown (`data-task-at`), so the preview can tick it
 * by changing the note; such a box is not disabled. Pages made from the tree
 * (export) disable every box again.
 */
const tasks: PreviewRenderer = {
  id: 'devot.tasks',
  apiVersion: PREVIEW_API_VERSION,
  transform(tree, { source }) {
    rewrite(tree, (li) => {
      if (li.tagName !== 'li') return undefined
      const offset = li.position?.start.offset
      const match = offset === undefined ? null : TASK.exec(source.slice(offset, offset + 40))
      const lead = li.children.find((c): c is Element => c.type === 'element')
      const box =
        lead?.tagName === 'input'
          ? lead
          : lead?.tagName === 'p'
            ? lead.children.find((c): c is Element => c.type === 'element')
            : undefined
      if (
        match &&
        offset !== undefined &&
        box?.tagName === 'input' &&
        box.properties['type'] === 'checkbox'
      ) {
        box.properties['dataTaskAt'] = offset + match[0].length - 2
        delete box.properties['disabled']
      }
      return undefined
    })
  },
}

// --- Islands: content the page renders itself ------------------------------

/**
 * Marks an element whose content the UI renders (it needs the page's layout
 * engine, as Mermaid does). The patcher leaves an island's children alone; the
 * UI's island registry fills it from `data-island-source`.
 */
export function island(kind: string, source: string): Element {
  return el('div', {
    className: ['island', `island-${kind}`],
    dataDevotIsland: kind,
    dataIslandSource: source,
  })
}

const mermaid: PreviewRenderer = {
  id: 'devot.mermaid',
  apiVersion: PREVIEW_API_VERSION,
  transform(tree) {
    rewrite(tree, (node) => {
      if (node.tagName !== 'pre') return undefined
      const code = node.children.find((c): c is Element => c.type === 'element')
      const classes = (code?.properties['className'] as string[] | undefined) ?? []
      if (!code || !classes.includes('language-mermaid')) return undefined
      return island('mermaid', textOf(code))
    })
  },
}

// --- Colour swatches -------------------------------------------------------

const COLOR =
  /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([0-9.,%\s/]+\)|hsla?\([0-9.,%\sdegra/]+\))$/i

const swatches: PreviewRenderer = {
  id: 'devot.swatches',
  apiVersion: PREVIEW_API_VERSION,
  transform(tree) {
    rewrite(tree, (node) => {
      if (node.tagName === 'pre') return node // code blocks: leave alone
      if (node.tagName !== 'code') return undefined
      const value = textOf(node).trim()
      if (COLOR.test(value)) {
        node.children.unshift(
          el('span', { className: ['swatch'], dataSwatchColor: value, ariaHidden: 'true' }),
        )
      }
      return node
    })
  },
}

// --- Images ------------------------------------------------------------------

/**
 * An image's size (see core/images.ts) leaves its alt text and URL: a
 * preset (`w:240` in the alt text, or an old `#small` on the URL) becomes a
 * class, and any other size its `width` and `height`; an image
 * alone in its paragraph gets `image-block`. An image
 * written as `![alt](url)` also gets where it is in the Markdown
 * (`data-image-from`, `data-image-to`), so its size can be set from the
 * preview; reference images and raw HTML get none.
 */
const images: PreviewRenderer = {
  id: 'devot.images',
  apiVersion: PREVIEW_API_VERSION,
  transform(tree, { source }) {
    rewrite(tree, (node, parent) => {
      if (node.tagName !== 'img') return undefined
      const src = node.properties['src']
      const names: string[] = []
      let size: string = 'auto'
      if (typeof src === 'string') {
        const split = splitImageSize(src)
        node.properties['src'] = split.url
        size = split.size
      }
      const alt = node.properties['alt']
      if (typeof alt === 'string') {
        const { name, dimensions } = splitAltSize(alt)
        if (dimensions) {
          node.properties['alt'] = name
          const preset = presetOf(dimensions)
          size = preset ?? 'auto'
          if (!preset && dimensions.width)
            node.properties['width'] = sizeAttribute(dimensions.width)
          if (!preset && dimensions.height)
            node.properties['height'] = sizeAttribute(dimensions.height)
        }
      }
      if (size !== 'auto') names.push(`image-size-${size}`)
      // An image on a paragraph of its own shows in a frame.
      const alone =
        parent.type === 'element' &&
        parent.tagName === 'p' &&
        parent.children.every((c) => c === node || isBlank(c))
      if (alone) names.push('image-block')
      if (names.length > 0) node.properties['className'] = names
      const from = node.position?.start.offset
      const to = node.position?.end.offset
      if (from !== undefined && to !== undefined && parseImageMarkdown(source.slice(from, to))) {
        node.properties['dataImageFrom'] = from
        node.properties['dataImageTo'] = to
      }
      return node
    })
  },
}

// --- devot:// links ----------------------------------------------------------

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const NOTE_URL = new RegExp(`^devot://note/${UUID}$`)
const FILE_URL = new RegExp(`^devot://file/${UUID}$`)

const links: PreviewRenderer = {
  id: 'devot.links',
  apiVersion: PREVIEW_API_VERSION,
  transform(tree) {
    rewrite(tree, (node) => {
      const check = (key: string, valid: RegExp) => {
        const value = node.properties[key]
        if (typeof value === 'string' && /^devot:/i.test(value) && !valid.test(value)) {
          delete node.properties[key]
        }
      }
      if (node.tagName === 'a') check('href', NOTE_URL)
      if (node.tagName === 'img') check('src', FILE_URL)
      return undefined
    })
  },
}

// --- Embeds ----------------------------------------------------------------

/** Origins that load without a click: privacy-friendly video players. */
const DIRECT_HOSTS = new Set([
  'www.youtube-nocookie.com',
  'player.vimeo.com',
  'player.bilibili.com',
])
const YT_ID = /^[A-Za-z0-9_-]{11}$/

function parseHttps(value: unknown): URL | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname ? url : null
  } catch {
    return null
  }
}

/** The player URL for a video page on a well-known provider. */
export function videoEmbedUrl(value: string): string | null {
  const url = parseHttps(value)
  if (!url) return null
  const host = url.hostname.replace(/^(?:www\.|m\.)/, '')
  const path = url.pathname.split('/').filter(Boolean)
  let id: string | undefined
  if (host === 'youtube.com' && path[0] === 'watch') id = url.searchParams.get('v') ?? undefined
  if (host === 'youtube.com' && (path[0] === 'shorts' || path[0] === 'embed')) id = path[1]
  if (host === 'youtu.be') id = path[0]
  if (id !== undefined) {
    return YT_ID.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null
  }
  if (host === 'vimeo.com' && path.length === 1 && /^\d{1,12}$/.test(path[0] ?? '')) {
    return `https://player.vimeo.com/video/${path[0]}`
  }
  if (host === 'bilibili.com' && path[0] === 'video' && /^BV[0-9A-Za-z]{10}$/.test(path[1] ?? '')) {
    return `https://player.bilibili.com/player.html?bvid=${path[1]}&autoplay=0`
  }
  return null
}

const SANDBOX = [
  'allow-scripts',
  'allow-same-origin',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-presentation',
]

function safeFrame(src: string, title: string): Element {
  return el('iframe', {
    src,
    sandbox: [...SANDBOX],
    allow: 'fullscreen; picture-in-picture; encrypted-media',
    allowFullScreen: true,
    referrerPolicy: 'strict-origin-when-cross-origin',
    loading: 'lazy',
    title,
    className: ['embed-frame'],
  })
}

const videoEmbeds: PreviewRenderer = {
  id: 'devot.video-embeds',
  apiVersion: PREVIEW_API_VERSION,
  transform(tree, { labels }) {
    rewrite(tree, (node) => {
      if (node.tagName !== 'p') return undefined
      const content = node.children.filter((c) => !isBlank(c))
      const only = content.length === 1 ? content[0] : undefined
      if (only?.type !== 'element' || only.tagName !== 'a') return undefined
      const href = only.properties['href']
      if (typeof href !== 'string' || textOf(only).trim() !== href) return undefined
      const src = videoEmbedUrl(href)
      return src
        ? el('div', { className: ['embed-video'] }, [safeFrame(src, labels.videoTitle)])
        : undefined
    })
  },
}

const iframes: PreviewRenderer = {
  id: 'devot.iframes',
  apiVersion: PREVIEW_API_VERSION,
  transform(tree, { labels, loadedEmbeds }) {
    rewrite(tree, (node) => {
      if (node.tagName !== 'iframe') return undefined
      const url = parseHttps(node.properties['src'])
      if (!url) return null
      const src = videoEmbedUrl(url.href) ?? url.href
      if (DIRECT_HOSTS.has(new URL(src).hostname) || loadedEmbeds.includes(src)) {
        return safeFrame(src, labels.videoTitle)
      }
      return el('div', { className: ['embed-placeholder'], dataEmbedSrc: src }, [
        el('span', { className: ['embed-placeholder-text'] }, [
          txt(fillPlaceholders(labels.embedFrom, { origin: url.hostname })),
        ]),
        el('button', { type: 'button', className: ['embed-load'], dataEmbedLoad: true }, [
          txt(labels.embedLoad),
        ]),
      ])
    })
  },
}

export const BUILTIN_RENDERERS: readonly PreviewRenderer[] = [
  frontmatter,
  alerts,
  tasks,
  createMathRenderer(),
  createEmojiRenderer(),
  mermaid,
  createCodeRenderer(),
  swatches,
  images,
  links,
  noteLinkChips,
  videoEmbeds,
  iframes,
]
