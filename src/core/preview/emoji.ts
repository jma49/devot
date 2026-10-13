// Emoji shortcodes (`:tada:`) become emoji characters. The shortcode table
// loads only for notes that contain something shaped like a shortcode.
import type { Element, Root, RootContent } from 'hast'
import { PREVIEW_API_VERSION, type PreviewRenderer } from './registry'

export type EmojiTable = ReadonlyMap<string, string>

export async function loadEmojiTable(): Promise<EmojiTable> {
  const { gemoji } = await import('gemoji')
  return new Map(gemoji.flatMap((g) => g.names.map((name) => [name, g.emoji] as const)))
}

const SHORTCODE = /:([a-z0-9_+-]+):/g
const HAS_SHORTCODE = /:[a-z0-9_+-]+:/
const SKIP = new Set(['code', 'pre', 'kbd', 'samp'])

function textNodes(node: Root | Element, out: { value: string }[] = []) {
  for (const child of node.children as RootContent[]) {
    if (child.type === 'text') out.push(child)
    else if (child.type === 'element' && !SKIP.has(child.tagName)) textNodes(child, out)
  }
  return out
}

export function createEmojiRenderer(
  load: () => Promise<EmojiTable> = loadEmojiTable,
): PreviewRenderer {
  return {
    id: 'devot.emoji',
    apiVersion: PREVIEW_API_VERSION,
    async transform(tree) {
      const candidates = textNodes(tree).filter((t) => HAS_SHORTCODE.test(t.value))
      if (candidates.length === 0) return
      const table = await load()
      for (const text of candidates) {
        text.value = text.value.replace(
          SHORTCODE,
          (whole, name: string) => table.get(name) ?? whole,
        )
      }
    },
  }
}
