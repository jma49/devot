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
import {
  PREVIEW_API_VERSION,
  type AlertKind,
  type PreviewNote,
  type PreviewRenderer,
} from './registry'
import { fillPlaceholders } from '../text'
import { createCodeRenderer } from './code'
import { glyph } from './glyphs'
import { headingIds } from './headingIds'
import { noteLinkChips } from './noteLinks'
import { parse, stringify } from 'yaml'
import { noteTitle, readFrontMatterYaml, type FrontMatterMeta } from '../import'
import { sameName } from '../tags'

type Parent = Root | Element
type Rewrite = (el: Element, parent: Parent) => ElementContent | ElementContent[] | null | undefined

/** A replacement takes the replaced element's place in the source, so the preview still knows which line it comes from. */
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

function valueText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && !(value instanceof Date)) return stringify(value).trimEnd()
  return value instanceof Date ? value.toISOString() : String(value)
}

type NoteField = 'title' | 'status' | 'tags'

const chip = (name: string, note: PreviewNote | undefined): Element => {
  const color = note?.tagColors.find((tag) => sameName(tag.name, name))?.color
  const className = color
    ? ['frontmatter-chip', 'tag-chip', `tag-color-${color}`]
    : ['frontmatter-chip']
  return el('span', { className }, [txt(name)])
}

/** The note's own value beside the front matter's, and an Apply that sets it from the front matter. */
function difference(
  field: NoteField,
  shown: string,
  value: string | null,
  note: PreviewNote,
): Element {
  const { labels } = note
  const badge = fillPlaceholders(labels.noteValue, { value: shown })
  const out: ElementContent[] = [
    el('span', { className: ['frontmatter-badge'], title: badge }, [txt(badge)]),
  ]
  if (value !== null && note.canApply) {
    const name = { title: labels.applyTitle, status: labels.applyStatus, tags: labels.applyTags }
    out.push(
      el(
        'button',
        {
          type: 'button',
          className: ['frontmatter-apply'],
          ariaLabel: name[field],
          dataFrontmatterApply: field,
          dataFrontmatterValue: value,
        },
        [txt(labels.apply)],
      ),
    )
  }
  return el('span', { className: ['frontmatter-note'] }, out)
}

/** What a field's row adds when the front matter says something other than the note: null when they agree. */
function fieldDifference(
  field: NoteField,
  meta: FrontMatterMeta,
  written: string,
  note: PreviewNote,
  untitled: string,
): Element | null {
  if (field === 'title') {
    if (meta.title === null || meta.title.trim() === '') return null
    const title = noteTitle(meta.title)
    if (title === note.title) return null
    return difference(field, note.title || untitled, title, note)
  }
  if (field === 'status') {
    if (meta.status === note.status) return null
    // Text that names no status cannot be applied, but it still is not the note's status.
    if (meta.status === null && written.trim() === '') return null
    return difference(field, note.labels.statuses[note.status], meta.status, note)
  }
  const same =
    meta.tags.length === note.tags.length &&
    meta.tags.every((name) => note.tags.some((own) => sameName(own, name)))
  if (same) return null
  const shown = note.tags.length > 0 ? note.tags.join(', ') : note.labels.noTags
  return difference(field, shown, JSON.stringify(meta.tags), note)
}

const isNoteField = (key: string): key is NoteField =>
  key === 'title' || key === 'status' || key === 'tags'

function propertiesBlock(
  yaml: string,
  note: PreviewNote | undefined,
  untitled: string,
): Element | null {
  let data: unknown
  try {
    data = parse(yaml, { maxAliasCount: 16 })
  } catch {
    return null
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const entries = Object.entries(data as Record<string, unknown>)
  const meta = note ? readFrontMatterYaml(yaml) : null
  // As import reads them: keys match in any case and the last of a repeated one counts.
  const fieldRows = new Map<NoteField, number>()
  entries.forEach(([key], i) => {
    const field = key.toLowerCase()
    if (isNoteField(field)) fieldRows.set(field, i)
  })
  const fieldAt = new Map([...fieldRows].map(([field, i]) => [i, field]))
  const rows = entries.map(([key, value], i) => {
    const field = note && meta ? fieldAt.get(i) : undefined
    const list = Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object')
    const dd: ElementContent[] =
      field === 'tags' && meta
        ? meta.tags.map((name) => chip(name, note))
        : list
          ? (value as unknown[]).map((v) => chip(valueText(v), undefined))
          : [txt(valueText(value))]
    if (field && meta && note) {
      const added = fieldDifference(field, meta, valueText(value), note, untitled)
      // A space, so the badge can wrap under a long value; chips are spaced by their row.
      if (added && dd[0]?.type === 'text') dd.push(txt(' '), added)
      else if (added) dd.push(added)
    }
    return el('div', { className: ['frontmatter-row'] }, [
      el('dt', {}, [txt(key)]),
      el('dd', {}, dd),
    ])
  })
  return rows.length > 0 ? el('dl', { className: ['frontmatter'] }, rows) : null
}

/** YAML that is not a map of keys shows as code. */
const frontmatter: PreviewRenderer = {
  id: 'devot.frontmatter',
  apiVersion: PREVIEW_API_VERSION,
  transform(tree, { frontmatter: yaml, note, labels }) {
    if (yaml === null) return
    const block =
      propertiesBlock(yaml, note, labels.untitled) ??
      el('pre', { className: ['frontmatter'] }, [
        el('code', { className: ['language-yaml'] }, [txt(yaml)]),
      ])
    // Front matter always opens the note.
    block.position = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }
    tree.children.unshift(block)
  },
}

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

const TASK = /^(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\]/

/** `data-task-at` is where the mark is in the Markdown, so the preview can tick it by changing the note; such a box is not disabled. Pages made from the tree (export) disable every box again. */
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

/** The patcher leaves an island's children alone; the UI's island registry fills it from `data-island-source`. */
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

/** Reference images and raw HTML get no `data-image-from`/`data-image-to` (where the image is in the Markdown, so its size can be set from the preview). */
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
      const host = new URL(src).hostname
      if (DIRECT_HOSTS.has(host) || loadedEmbeds.includes(src)) {
        // A video player is a video; any other page is named by its host.
        const title = DIRECT_HOSTS.has(host)
          ? labels.videoTitle
          : fillPlaceholders(labels.embedFrom, { origin: host })
        return safeFrame(src, title)
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
  headingIds,
  swatches,
  images,
  links,
  noteLinkChips,
  videoEmbeds,
  iframes,
]
