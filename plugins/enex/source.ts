import { SaxesParser } from 'saxes'
import { characterEntities } from 'character-entities'
import { md5 } from '@noble/hashes/legacy'
import { bytesToHex } from '@noble/hashes/utils'
import type { DevotConvertedNote, DevotFile, DevotApi } from '../../plugin-kit/types'

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
  node.children.filter((c): c is XmlNode => typeof c !== 'string' && c.name === name)
const textOf = (node: XmlNode): string =>
  node.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('')
const value = (node: XmlNode, name: string) => children(node, name).map(textOf)[0] ?? ''
const escape = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

function date(source: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(source)
  if (!m) return undefined
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`
  const at = Date.parse(iso)
  return Number.isSafeInteger(at) && at >= 0 && new Date(at).toISOString() === iso ? at : undefined
}

function resourceName(name: string): string {
  const chars = [...name]
  if (chars.length <= 200) return name
  const dot = chars.lastIndexOf('.')
  const extension = dot > 0 && chars.length - dot < 200 ? chars.slice(dot) : []
  return chars.slice(0, 200 - extension.length).join('') + extension.join('')
}

function convertNote(note: XmlNode): DevotConvertedNote {
  const attachments: NonNullable<DevotConvertedNote['attachments']> = []
  const diagnostics: string[] = []
  const resources = new Map<string, number>()
  const referenced = new Set<number>()
  for (const resource of children(note, 'resource')) {
    try {
      const data = value(resource, 'data').replace(/\s/g, '')
      if (data.length > Math.ceil((10 * 1024 * 1024) / 3) * 4)
        throw new Error('E_FILE_SIZE_INVALID')
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
      const hash = bytesToHex(md5(bytes))
      const attrs = children(resource, 'resource-attributes')[0]
      const mime = value(resource, 'mime') || 'application/octet-stream'
      const name = (attrs && value(attrs, 'file-name')) || `resource-${attachments.length + 1}`
      resources.set(hash, attachments.length)
      attachments.push({ name: resourceName(name), mime, data })
    } catch (error) {
      diagnostics.push(
        error instanceof Error && error.message === 'E_FILE_SIZE_INVALID'
          ? 'E_FILE_SIZE_INVALID'
          : 'E_IMPORT_ATTACHMENT_INVALID',
      )
    }
  }
  const root = xml(value(note, 'content') || '<en-note/>', true)
  if (root.name !== 'en-note') throw new Error('E_IMPORT_ENEX_CONTENT')
  const image = (index: number) => `<img src="attachment:${index}" alt=""/>`
  const render = (node: XmlNode | string): string => {
    if (typeof node === 'string') return escape(node)
    if (node.name === 'en-crypt') {
      diagnostics.push('E_IMPORT_ENCRYPTED')
      return ''
    }
    if (node.name === 'en-media') {
      const index = resources.get((node.attrs.hash ?? '').toLowerCase())
      if (index === undefined) {
        diagnostics.push('E_IMPORT_ATTACHMENT_MISSING')
        return ''
      }
      referenced.add(index)
      return image(index)
    }
    if (node.name === 'en-todo')
      return `<input type="checkbox" disabled${node.attrs.checked === 'true' ? ' checked' : ''}/>`
    const body = node.children.map(render).join('')
    if (node.name !== 'li' && children(node, 'en-todo').length) return `<ul><li>${body}</li></ul>`
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
  attachments.forEach((_, index) => {
    if (!referenced.has(index)) html += `<div>${image(index)}</div>`
  })
  const now = Date.now()
  const createdAt = date(value(note, 'created')) ?? now
  const updatedAt = Math.max(createdAt, date(value(note, 'updated')) ?? now)
  return {
    title: [...value(note, 'title')].slice(0, 1000).join(''),
    html,
    attachments,
    tags: children(note, 'tag').map(textOf),
    createdAt,
    updatedAt,
    diagnostics,
  }
}

function convert(file: DevotFile): DevotConvertedNote[] {
  const root = xml(file.text)
  if (root.name !== 'en-export') throw new Error('E_IMPORT_ENEX_XML')
  return children(root, 'note').map(convertNote)
}

declare const devot: DevotApi
devot.importer.handle('enex', convert)
