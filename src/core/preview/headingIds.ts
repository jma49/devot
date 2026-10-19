// Headings get slug ids, so `[text](#heading)` links jump within a note. The
// rules are GitHub's: lower-case, punctuation dropped, spaces to hyphens, and
// `-1`, `-2` on repeats. Ids are set after sanitizing, from the heading's text,
// with the sanitizer's prefix, so they never match the app's own ids.
import type { Element, Root, RootContent } from 'hast'
import { PREVIEW_API_VERSION, type PreviewRenderer } from './registry'

const DROPPED = /[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu

export const ID_PREFIX = 'user-content-'

/** The element id a `#fragment` link in a note means. */
export const fragmentId = (fragment: string) =>
  fragment.startsWith(ID_PREFIX) ? fragment : ID_PREFIX + fragment

export function slug(text: string): string {
  return text.toLowerCase().replace(DROPPED, '').replace(/ /g, '-')
}

export function createSlugger(): (text: string) => string {
  const used = new Map<string, number>()
  return (text) => {
    const base = slug(text)
    let id = base
    // A repeat can collide with a heading that is literally named `a-1`.
    while (used.has(id)) {
      const n = (used.get(base) ?? 0) + 1
      used.set(base, n)
      id = `${base}-${n}`
    }
    used.set(id, 0)
    return id
  }
}

const HEADING = /^h[1-6]$/

function textOf(node: RootContent | Root): string {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map(textOf).join('') : ''
}

function visit(node: Root | Element, next: (text: string) => string): void {
  for (const child of node.children) {
    if (child.type !== 'element') continue
    if (HEADING.test(child.tagName) && child.properties['id'] === undefined) {
      const id = next(textOf(child))
      if (id) child.properties['id'] = ID_PREFIX + id
    }
    visit(child, next)
  }
}

export const headingIds: PreviewRenderer = {
  id: 'devot.headingIds',
  apiVersion: PREVIEW_API_VERSION,
  transform(tree) {
    visit(tree, createSlugger())
  },
}
