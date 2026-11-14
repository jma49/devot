// Bear's tags, written in the text: `#tag`, `#nested/tag` and `#multi word tag#` (closed by a `#` when it holds spaces).
// Only plain text counts: code, links, images, HTML and front matter hold none, and nor does a heading's marker.

import type { Nodes, Root } from 'mdast'
import { charCount } from './text'
import { MAX_TAG_NAME_CHARS } from './tagNames'

const TAG = /(?<=^|[\s(])#(?:([^\s#](?:[^#\n]*[^\s#])?)#|([^\s#]+))/gu
const TRAILING = /[.,;:!?)\]}'"]+$/u
const SKIPPED = new Set([
  'code',
  'inlineCode',
  'link',
  'linkReference',
  'image',
  'html',
  'yaml',
  'math',
  'inlineMath',
])

/** Each tag once, in the order it first appears. */
export function bearTags(tree: Root): string[] {
  const found = new Map<string, string>()
  const add = (raw: string) => {
    const name = raw.replace(/\/+$/, '').trim()
    if (name === '' || /^\d+$/.test(name) || charCount(name) > MAX_TAG_NAME_CHARS) return
    const key = name.toLowerCase()
    if (!found.has(key)) found.set(key, name)
  }
  const walk = (node: Nodes) => {
    if (SKIPPED.has(node.type)) return
    if (node.type === 'text') {
      for (const match of node.value.matchAll(TAG)) {
        if (match[1] !== undefined) add(match[1])
        else add(match[2]!.replace(TRAILING, ''))
      }
      return
    }
    if ('children' in node) for (const child of node.children) walk(child as Nodes)
  }
  walk(tree)
  return [...found.values()]
}
