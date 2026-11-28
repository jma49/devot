import { fromBase64 } from '../base64'
import { importMarkdown, imageLinks, type ImportOptions, type PreparedImport } from '../import'
import { checkUpload, detectImage, fileUri, MAX_FILE_BYTES } from '../files'
import { htmlToMarkdown } from '../htmlImport'
import { replaceRanges } from '../text'
import { errorCode } from '../errors'
import { parseMarkdown } from '../frontMatter'
import type { Definition, Nodes } from 'mdast'
import { toMarkdown } from 'mdast-util-to-markdown'
import type { Nodes as HtmlNodes } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { toHtml } from 'hast-util-to-html'
import { checkResult, type Converted } from './protocol'

type PluginImportOptions = Omit<ImportOptions, 'scan' | 'source' | 'prepare'> & {
  name: string
  converted: Converted | Converted[]
}

function inlineImageReferences(text: string): string {
  const tree = parseMarkdown(text)
  const definitions = new Map<string, Definition>()
  const images = new Set<string>()
  const links = new Set<string>()
  const walk = (node: Nodes, visit: (node: Nodes) => void) => {
    visit(node)
    if ('children' in node) node.children.forEach((child) => walk(child, visit))
  }
  walk(tree, (node) => {
    if (node.type === 'definition' && !definitions.has(node.identifier))
      definitions.set(node.identifier, node)
    if (node.type === 'imageReference') images.add(node.identifier)
    if (node.type === 'linkReference') links.add(node.identifier)
  })
  const changes: { start: number; end: number; text: string }[] = []
  walk(tree, (node) => {
    let replacement: string | undefined
    if (node.type === 'imageReference') {
      const definition = definitions.get(node.identifier)
      if (definition)
        replacement = toMarkdown(
          { type: 'image', alt: node.alt, url: definition.url, title: definition.title },
          { unsafe: [{ character: '|' }] },
        ).trimEnd()
    } else if (
      node.type === 'definition' &&
      images.has(node.identifier) &&
      !links.has(node.identifier)
    )
      replacement = ''
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (replacement !== undefined && start !== undefined && end !== undefined)
      changes.push({ start, end, text: replacement })
  })
  return replaceRanges(text, changes)
}

function prepare(note: Converted, options: PluginImportOptions): PreparedImport {
  const embedded: PreparedImport['embedded'] = []
  const diagnostics: NonNullable<PreparedImport['diagnostics']> = (note.diagnostics ?? []).map(
    (code) => ({ code }),
  )
  const uris = new Map<number, string>()
  for (const [index, attachment] of (note.attachments ?? []).entries()) {
    try {
      if (attachment.data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4)
        throw new Error('E_FILE_SIZE_INVALID')
      const data = fromBase64(attachment.data)
      const mime = detectImage(data)
      if (!mime || !attachment.mime.startsWith('image/'))
        throw new Error('E_IMPORT_ATTACHMENT_UNSUPPORTED')
      const id = options.newId()
      checkUpload({ id, noteId: id, name: attachment.name }, data)
      if (!options.files) throw new Error('E_IMPORT_ATTACHMENT_STORAGE')
      embedded.push({ id, mime, data, name: attachment.name })
      uris.set(index, fileUri(id))
    } catch (error) {
      diagnostics.push({
        code: errorCode(error, 'E_IMPORT_ATTACHMENT_INVALID'),
        image: attachment.name,
      })
    }
  }
  let text = note.markdown ?? ''
  let marker = 'https://devot.invalid/import/'
  if (note.html !== undefined) {
    while (note.html.includes(marker)) marker += 'x/'
    const html = fromHtml(note.html)
    const rewrite = (node: HtmlNodes) => {
      if (node.type === 'element' && node.tagName === 'img') {
        for (const key of ['src', 'dataSrc']) {
          const value = node.properties[key]
          if (typeof value === 'string' && /^attachment:\d+$/.test(value.trim()))
            node.properties[key] = value.trim().replace('attachment:', marker)
        }
      }
      if ('children' in node) node.children.forEach(rewrite)
    }
    rewrite(html)
    const converted = htmlToMarkdown(toHtml(html), options.newId)
    text = converted.markdown
    embedded.push(...converted.images)
    diagnostics.push(...converted.dropped.map(() => ({ code: 'E_IMPORT_HTML_CONTENT_DROPPED' })))
  }
  text = inlineImageReferences(text)
  const links = imageLinks(text)
  const missing = new Set<string>()
  text = replaceRanges(
    text,
    links.flatMap((link) => {
      const index =
        note.html === undefined
          ? /^attachment:(\d+)$/.exec(link.url)?.[1]
          : link.url.startsWith(marker)
            ? link.url.slice(marker.length)
            : undefined
      if (index === undefined || !/^\d+$/.test(index)) return []
      if (Number(index) >= (note.attachments?.length ?? 0))
        diagnostics.push({ code: 'E_IMPORT_ATTACHMENT_MISSING' })
      const uri = uris.get(Number(index))
      if (!uri && !link.html) {
        missing.add(link.url)
        return []
      }
      return [{ start: link.start, end: link.end, text: uri ?? '' }]
    }),
  )
  const omitted: { start: number; end: number; text: string }[] = []
  const omit = (node: Nodes) => {
    if (node.type === 'image' && missing.has(node.url) && node.position) {
      const { start, end } = node.position
      if (start.offset !== undefined && end.offset !== undefined)
        omitted.push({ start: start.offset, end: end.offset, text: '' })
    } else if ('children' in node) node.children.forEach(omit)
  }
  if (missing.size) omit(parseMarkdown(text))
  text = replaceRanges(text, omitted)
  const now = Date.now()
  const createdAt = note.createdAt ?? now
  const updatedAt = Math.max(createdAt, note.updatedAt ?? now)
  return {
    title: note.title,
    meta: { title: null, notebook: null, status: null, tags: note.tags ?? [] },
    aliases: [],
    text,
    embedded,
    diagnostics,
    dropped: [],
    images: { links: [], unlocated: [], wiki: [] },
    ...(note.createdAt !== undefined || note.updatedAt !== undefined
      ? { dates: { createdAt, updatedAt } }
      : {}),
  }
}

export async function importConverted(options: PluginImportOptions) {
  const checked = checkResult('import.convert', options.converted, 3)
  const many = Array.isArray(checked)
  const notes = many ? checked : [checked]
  const name = (options.name.split('/').pop() ?? options.name).replace(/\.[^.]+$/, '') || 'Import'
  const paths = notes.map((_, index) => (many ? `${name}/${index + 1}.md` : `${index + 1}.md`))
  return importMarkdown({
    ...options,
    wikiLinks: false,
    layout: {
      app: null,
      appOf: () => null,
      noteFolder: (path) => (many ? path.split('/').slice(0, -1).join('/') : ''),
      folderName: () => name,
      fileTitle: () => '',
    },
    scan: {
      id: 0,
      name: options.name,
      kind: many ? 'folders' : 'files',
      files: paths.map((path) => ({ path, bytes: 0 })),
      images: [],
      skipped: [],
    },
    source: {
      read: async () => '',
      attach: async () => {
        throw new Error('E_IMPORT_ATTACHMENT_MISSING')
      },
    },
    prepare: {
      file: async (_, path) => prepare(notes[paths.indexOf(path)]!, options),
      links: async () => ({ links: [], unlocated: [], wiki: [] }),
    },
  })
}
