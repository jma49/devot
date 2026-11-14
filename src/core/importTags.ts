import type { Nodes } from 'mdast'
import {
  isExportBlock,
  parseMarkdown,
  readFrontMatterList,
  withoutFrontMatterKeys,
  yamlOf,
} from './frontMatter'

const TAG_KEYS = ['tags', 'tag']
const ALIAS_KEYS = ['aliases', 'alias']

/** The tags and other names a note's own front matter gives it, and the note without those keys. */
export function noteTags(markdown: string): { tags: string[]; aliases: string[]; body: string } {
  const yaml = yamlOf(parseMarkdown(markdown))
  if (yaml === null || isExportBlock(yaml)) return { tags: [], aliases: [], body: markdown }
  return {
    tags: readFrontMatterList(yaml, TAG_KEYS),
    aliases: readFrontMatterList(yaml, ALIAS_KEYS, true),
    body: withoutFrontMatterKeys(markdown, [...TAG_KEYS, ...ALIAS_KEYS]),
  }
}

// A tag starts a word and has a letter in it, so `#42` and `C#` stay text.
const TAG = /(?<![\p{L}\p{N}_#/&])#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)/gu
const SKIPPED = new Set([
  'heading',
  'link',
  'linkReference',
  'definition',
  'code',
  'inlineCode',
  'html',
  'yaml',
  'math',
  'inlineMath',
])

/** The `#tags` written in a note's text, outside headings, code and links, each once. */
export function bodyTags(markdown: string): string[] {
  const seen = new Map<string, string>()
  const walk = (node: Nodes) => {
    if (SKIPPED.has(node.type)) return
    if (node.type === 'text') {
      for (const match of node.value.matchAll(TAG)) {
        const tag = match[1]!.replace(/\/+$/, '')
        if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag)
      }
    }
    if ('children' in node) for (const child of node.children) walk(child as Nodes)
  }
  walk(parseMarkdown(markdown))
  return [...seen.values()]
}
