// Built-in preview renderers. They run on the sanitized tree and only build
// structure from validated values.
import type { Element, ElementContent, Properties, Root, RootContent } from 'hast'
import { textOf } from '../hastText'
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
  type RemoteImageWait,
} from './registry'
import { remoteImageHost } from './remoteImages'
import { fillPlaceholders } from '../text'
import { createCodeRenderer } from './code'
import { glyph } from './glyphs'
import { headingIds } from './headingIds'
import { noteLinkChips } from './noteLinks'
import { customTagColorProperties, tagColorClass } from '../tags'
import type { TagColorValue } from '../storage'
import { frontMatterView, type FrontMatterView, type PropertyDifference } from './frontMatterView'

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

const isBlank = (node: RootContent) => node.type === 'text' && node.value.trim() === ''

const chip = (name: string, color: TagColorValue | undefined): Element => {
  const className = color
    ? ['frontmatter-chip', 'tag-chip', tagColorClass(color)]
    : ['frontmatter-chip']
  return el('span', { className, ...customTagColorProperties(color) }, [txt(name)])
}

/** The note's own value beside the front matter's, and an Apply that sets it from the front matter. */
function differenceBadge(added: PropertyDifference, note: PreviewNote): Element {
  const { labels } = note
  const out: ElementContent[] = [
    el('span', { className: ['frontmatter-badge'], title: added.badge }, [txt(added.badge)]),
  ]
  if (added.value !== null && note.canApply) {
    const name = { title: labels.applyTitle, status: labels.applyStatus, tags: labels.applyTags }
    out.push(
      el(
        'button',
        {
          type: 'button',
          className: ['frontmatter-apply'],
          ariaLabel: name[added.field],
          dataFrontmatterApply: added.field,
          dataFrontmatterValue: added.value,
        },
        [txt(labels.apply)],
      ),
    )
  }
  return el('span', { className: ['frontmatter-note'] }, out)
}

function frontMatterBlock(view: FrontMatterView, note: PreviewNote | undefined): Element {
  if (view.kind === 'yaml') {
    return el('pre', { className: ['frontmatter'] }, [
      el('code', { className: ['language-yaml'] }, [txt(view.yaml)]),
    ])
  }
  const rows = view.rows.map(({ key, value, difference }) => {
    const dd: ElementContent[] =
      value.kind === 'chips' ? value.chips.map((c) => chip(c.name, c.color)) : [txt(value.text)]
    if (difference && note) {
      const added = differenceBadge(difference, note)
      // A space, so the badge can wrap under a long value; chips are spaced by their row.
      if (value.kind === 'text') dd.push(txt(' '), added)
      else dd.push(added)
    }
    return el('div', { className: ['frontmatter-row'] }, [
      el('dt', {}, [txt(key)]),
      el('dd', {}, dd),
    ])
  })
  return el('dl', { className: ['frontmatter'] }, rows)
}

/** YAML that is not a map of keys shows as code. */
const frontmatter: PreviewRenderer = {
  id: 'devot.frontmatter',
  apiVersion: PREVIEW_API_VERSION,
  transform(tree, { frontmatter: yaml, note, labels, frontMatterInInfo }) {
    if (yaml === null || frontMatterInInfo) return
    const block = frontMatterBlock(frontMatterView(yaml, note, labels.untitled), note)
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

function diagramRenderer(kind: string, languages = [kind]): PreviewRenderer {
  return {
    id: `devot.${kind}`,
    apiVersion: PREVIEW_API_VERSION,
    transform(tree) {
      rewrite(tree, (node) => {
        if (node.tagName !== 'pre') return undefined
        const code = node.children.find((c): c is Element => c.type === 'element')
        const classes = (code?.properties['className'] as string[] | undefined) ?? []
        if (!code || !languages.some((language) => classes.includes(`language-${language}`)))
          return undefined
        return island(kind, textOf(code))
      })
    },
  }
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
/** In place of an image from the web until its site is loaded: nothing is fetched from it. */
function remoteImagePlaceholder(host: string, labels: RemoteImageWait): Element {
  return el('span', { className: ['image-placeholder'], dataRemoteImageHost: host }, [
    el('span', { className: ['image-placeholder-text'] }, [
      txt(fillPlaceholders(labels.from, { origin: host })),
    ]),
    el('button', { type: 'button', className: ['embed-load'], dataRemoteImageLoad: true }, [
      txt(labels.load),
    ]),
  ])
}

const images: PreviewRenderer = {
  id: 'devot.images',
  apiVersion: PREVIEW_API_VERSION,
  transform(tree, { source, remoteImages }) {
    rewrite(tree, (node, parent) => {
      if (node.tagName !== 'img') return undefined
      const src = node.properties['src']
      const host = typeof src === 'string' ? remoteImageHost(src) : null
      if (remoteImages && host !== null && !remoteImages.loadedHosts.includes(host))
        return remoteImagePlaceholder(host, remoteImages)
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
  diagramRenderer('mermaid'),
  diagramRenderer('plantuml', ['plantuml', 'puml']),
  diagramRenderer('markmap'),
  createCodeRenderer(),
  headingIds,
  swatches,
  images,
  links,
  noteLinkChips,
  videoEmbeds,
  iframes,
]
