import { SaxesParser } from 'saxes'
import { characterEntities } from 'character-entities'
import { md5 } from '@noble/hashes/legacy'
import { bytesToHex } from '@noble/hashes/utils'
import { checkUpload, detectImage, fileUri, MAX_FILE_BYTES } from './files'
import { htmlToMarkdown } from './htmlImport'
import { clipTitle } from './noteLimits'
import { errorCode } from './errors'
import type { ImportOptions, ImportProblem, PreparedImport } from './import'

interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: (XmlNode | string)[]
}

function xml(source: string, xhtml = false): XmlNode {
  const parser = new SaxesParser()
  if (xhtml) Object.assign(parser.ENTITIES, characterEntities)
  const stack: XmlNode[] = []
  let root: XmlNode | undefined
  parser.on('opentag', (tag) => {
    const node: XmlNode = { name: tag.name, attrs: tag.attributes, children: [] }
    if (stack.length) stack[stack.length - 1]!.children.push(node)
    else root = node
    stack.push(node)
  })
  const text = (value: string) => stack[stack.length - 1]?.children.push(value)
  parser.on('text', text)
  parser.on('cdata', text)
  parser.on('closetag', () => {
    stack.pop()
  })
  try {
    parser.write(source).close()
  } catch {
    throw new Error('E_IMPORT_ENEX_XML')
  }
  if (!root) throw new Error('E_IMPORT_ENEX_XML')
  return root
}

const children = (node: XmlNode, name: string) =>
  node.children.filter(
    (child): child is XmlNode => typeof child !== 'string' && child.name === name,
  )
const textOf = (node: XmlNode): string =>
  node.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('')
const value = (node: XmlNode, name: string) => children(node, name).map(textOf)[0] ?? ''
const escape = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

function date(source: string, fallback: number): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(source)
  if (!match) return fallback
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`
  const at = Date.parse(iso)
  return Number.isSafeInteger(at) && at >= 0 && new Date(at).toISOString() === iso ? at : fallback
}

export interface EnexPrepared extends PreparedImport {
  dates: { createdAt: number; updatedAt: number }
  diagnostics: { code: string }[]
  embedded: (PreparedImport['embedded'][number] & { name?: string })[]
}

function prepareNote(note: XmlNode, options: ImportOptions): EnexPrepared {
  const content = value(note, 'content')
  const root = xml(content || '<en-note/>', true)
  if (root.name !== 'en-note') throw new Error('E_IMPORT_ENEX_CONTENT')
  let marker = 'DEVOTENEX'
  while (content.includes(marker) || textOf(root).includes(marker)) marker += 'X'
  const diagnostics: { code: string }[] = []
  const embedded: EnexPrepared['embedded'] = []
  const resources = new Map<string, string>()
  const referenced = new Set<string>()
  for (const resource of children(note, 'resource')) {
    try {
      const encoded = value(resource, 'data').replace(/\s/g, '')
      if (encoded.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw new Error('E_FILE_SIZE_INVALID')
      const binary = atob(encoded)
      const data = Uint8Array.from(binary, (char) => char.charCodeAt(0))
      const hash = bytesToHex(md5(data))
      const mime = detectImage(data)
      if (!mime) {
        diagnostics.push({ code: 'E_IMPORT_ENEX_RESOURCE_UNSUPPORTED' })
        resources.set(hash, '')
        continue
      }
      const id = options.newId()
      const attrs = children(resource, 'resource-attributes')[0]
      const name = (attrs && value(attrs, 'file-name')) || `image.${mime.split('/')[1]}`
      checkUpload({ id, noteId: id, name }, data)
      if (!options.files) throw new Error('E_IMPORT_ENEX_RESOURCE_STORAGE')
      embedded.push({ id, mime, data, name })
      resources.set(hash, fileUri(id))
    } catch (error) {
      diagnostics.push({ code: errorCode(error, 'E_IMPORT_ENEX_RESOURCE_INVALID') })
    }
  }
  // The HTML converter drops private URL schemes; resource links are restored afterwards.
  const uris: string[] = []
  const image = (uri: string) => {
    uris.push(uri)
    return `<img src="https://devot.invalid/${marker}/${uris.length - 1}" alt=""/>`
  }
  const render = (node: XmlNode | string): string => {
    if (typeof node === 'string') return escape(node)
    if (node.name === 'en-crypt') {
      diagnostics.push({ code: 'E_IMPORT_ENEX_ENCRYPTED' })
      return ''
    }
    if (node.name === 'en-media') {
      const hash = (node.attrs.hash ?? '').toLowerCase()
      referenced.add(hash)
      const uri = resources.get(hash)
      if (uri === undefined) diagnostics.push({ code: 'E_IMPORT_ENEX_RESOURCE_MISSING' })
      return uri ? image(uri) : ''
    }
    if (node.name === 'en-todo')
      return node.attrs.checked === 'true' ? `${marker}CHECKED ` : `${marker}UNCHECKED `
    const body = node.children.map(render).join('')
    if (node.name === 'en-note') return body
    const attrs = Object.entries(node.attrs)
      .map(([k, v]) => ` ${k}="${escape(v)}"`)
      .join('')
    if (
      [
        'br',
        'hr',
        'img',
        'input',
        'wbr',
        'area',
        'base',
        'col',
        'embed',
        'link',
        'meta',
        'param',
        'source',
        'track',
      ].includes(node.name)
    )
      return `<${node.name}${attrs}/>`
    return `<${node.name}${attrs}>${body}</${node.name}>`
  }
  let html = render(root)
  for (const [hash, uri] of resources) {
    if (uri && !referenced.has(hash)) {
      html += `<div>${image(uri)}</div>`
    }
  }
  const converted = htmlToMarkdown(html, options.newId)
  let text = converted.markdown
    .replace(
      new RegExp(`(^[ \\t]*(?:[-*+]|\\d+\\.)[ \\t]+)${marker}(UNCHECKED|CHECKED) `, 'gm'),
      (_, prefix: string, state: string) => `${prefix}[${state === 'CHECKED' ? 'x' : ' '}] `,
    )
    .replaceAll(`${marker}CHECKED `, '- [x] ')
    .replaceAll(`${marker}UNCHECKED `, '- [ ] ')
  for (let index = uris.length - 1; index >= 0; index--) {
    text = text.replaceAll(`https://devot.invalid/${marker}/${index}`, uris[index]!)
  }
  diagnostics.push(...converted.dropped.map(() => ({ code: 'E_IMPORT_HTML_CONTENT_DROPPED' })))
  const now = Date.now()
  const createdAt = date(value(note, 'created'), now)
  const updatedAt = Math.max(createdAt, date(value(note, 'updated'), now))
  return {
    title: clipTitle(value(note, 'title')),
    meta: { title: null, notebook: null, status: null, tags: children(note, 'tag').map(textOf) },
    aliases: [],
    text,
    images: { links: [], unlocated: [], wiki: [] },
    embedded,
    dropped: [],
    diagnostics,
    dates: { createdAt, updatedAt },
  }
}

export async function expandEnex(options: ImportOptions): Promise<ImportOptions> {
  const prepared = new Map<string, XmlNode>()
  const skipped: ImportProblem[] = [...options.scan.skipped]
  const names = new Set<string>()
  for (const file of options.scan.files) {
    if (await options.stopped?.()) {
      skipped.push({ path: file.path, code: 'E_IMPORT_STOPPED' })
      continue
    }
    try {
      const root = xml(await options.source.read(file.path))
      if (root.name !== 'en-export') throw new Error('E_IMPORT_ENEX_XML')
      const base = (file.path.split('/').pop() ?? file.path).replace(/\.enex$/i, '') || 'Import'
      let name = base
      for (let i = 2; names.has(name); i++) name = `${base} (${i})`
      names.add(name)
      children(root, 'note').forEach((note, index) => prepared.set(`${name}/${index + 1}.md`, note))
    } catch (error) {
      skipped.push({ path: file.path, code: errorCode(error, 'E_IMPORT_ENEX_XML') })
    }
  }
  return {
    ...options,
    wikiLinks: false,
    scan: {
      ...options.scan,
      kind: 'enex',
      files: [...prepared.keys()].map((path) => ({ path, bytes: 0 })),
      images: [],
      skipped,
    },
    source: { ...options.source, read: async () => '' },
    prepare: {
      file: async (_, path) => prepareNote(prepared.get(path)!, options),
      links: async () => ({ links: [], unlocated: [], wiki: [] }),
    },
  }
}
