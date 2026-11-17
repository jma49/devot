// Plugins' preview renderers (ADR 0005): a fenced code block in a plugin's language goes to the plugin, which answers Markdown.
// The answer is rendered and sanitized like note text, minus anything remote, so a plugin adds only what a note could; a block without an answer stays code.
// A renderer that answers SVG (ADR 0027) becomes an island instead: the page asks the plugin, which needs the theme on screen.
import type { Element, ElementContent, Root, RootContent } from 'hast'
import { textOf } from '../hastText'
import { island } from './builtins'
import {
  PIECE_OFFSET_PROPERTIES,
  PLUGIN_ISLAND,
  PREVIEW_API_VERSION,
  type NoteLinkTarget,
  type PreviewContext,
  type PreviewRenderer,
} from './registry'

export interface PluginRendererSpec {
  /** Names the renderer to the host (`<plugin id>/<renderer id>`). */
  key: string
  language: string
  output: 'markdown' | 'svg'
}

export type RenderPluginBlock = (key: string, source: string) => Promise<string | null>

/** The notes an answer links to that the note's own text does not: a plugin's answer may list notes the note never names. */
export type PluginLinkTargets = (ids: string[]) => Promise<Readonly<Record<string, NoteLinkTarget>>>

const NOTE_LINK = /devot:\/\/note\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g

async function withAnswerTargets(
  markdown: string,
  context: PreviewContext,
  linkTargets: PluginLinkTargets | undefined,
): Promise<PreviewContext> {
  const known = context.noteLinks
  // Without `noteLinks` the preview shows plain links (an export), so there is nothing to ask.
  if (!known || !linkTargets) return context
  const missing = [...new Set([...markdown.matchAll(NOTE_LINK)].map((m) => m[1] as string))].filter(
    (id) => !Object.hasOwn(known, id),
  )
  if (missing.length === 0) return context
  const found = await linkTargets(missing).catch(() => ({}))
  return { ...context, noteLinks: { ...known, ...found } }
}

/**
 * Whether a piece of a note may hold a block in one of `languages`: never wrong about a piece that does.
 * A fence may write its language with a character reference or a backslash escape, and raw HTML may hold a `pre`.
 */
export function mayHoldPluginBlock(text: string, languages: readonly string[]): boolean {
  if (languages.length === 0) return false
  if (!text.includes('```') && !text.includes('~~~') && !/<pre/i.test(text)) return false
  return text.includes('&') || text.includes('\\') || languages.some((l) => text.includes(l))
}

export type MarkdownNodes = (markdown: string, context: PreviewContext) => Promise<RootContent[]>

function languageOf(pre: Element): { code: Element; language: string } | undefined {
  const [code, ...rest] = pre.children
  if (rest.length > 0 || code?.type !== 'element' || code.tagName !== 'code') return undefined
  const names = code.properties['className']
  const name = Array.isArray(names)
    ? names.find((n) => typeof n === 'string' && n.startsWith('language-'))
    : undefined
  return typeof name === 'string' ? { code, language: name.slice('language-'.length) } : undefined
}

/** The answer's offsets count from the answer, not the note, so nothing in it may change the note. */
function makeInert(node: RootContent): void {
  delete node.position
  if (node.type === 'element') {
    for (const name of PIECE_OFFSET_PROPERTIES) delete node.properties[name]
    if (node.tagName === 'input') node.properties['disabled'] = true
    // An answer may link to notes, never to the web: the page opens an https
    // link outside Devot, and a plugin has no network permission.
    const href = node.properties['href']
    if (node.tagName === 'a' && typeof href === 'string' && !href.startsWith('devot:')) {
      delete node.properties['href']
    }
  }
  if ('children' in node) node.children.forEach(makeInert)
}

export function createPluginRenderer(
  specs: readonly PluginRendererSpec[],
  render: RenderPluginBlock,
  toNodes: MarkdownNodes,
  linkTargets?: PluginLinkTargets,
): PreviewRenderer {
  const byLanguage = new Map(specs.map((s) => [s.language, s]))
  return {
    id: 'devot.plugins',
    apiVersion: PREVIEW_API_VERSION,
    async transform(tree: Root, context: PreviewContext) {
      const found: { parent: Root | Element; at: number; pre: Element; key: string }[] = []
      const walk = (parent: Root | Element) => {
        parent.children.forEach((child, at) => {
          if (child.type !== 'element') return
          const block = child.tagName === 'pre' ? languageOf(child) : undefined
          const spec = block && byLanguage.get(block.language)
          if (spec?.output === 'svg') {
            const drawing = island(
              PLUGIN_ISLAND,
              `${spec.key}\n${textOf(child).replace(/\n$/, '')}`,
            )
            // Where the block is in the note, so the page can put an edit of it back (ADR 0029).
            if (child.position) {
              drawing.position = child.position
              const { start, end } = child.position
              if (start.offset !== undefined && end.offset !== undefined) {
                drawing.properties['dataBlockFrom'] = start.offset
                drawing.properties['dataBlockTo'] = end.offset
              }
            }
            parent.children[at] = drawing
          } else if (spec) found.push({ parent, at, pre: child, key: spec.key })
          else walk(child)
        })
      }
      walk(tree)
      await Promise.all(
        found.map(async ({ parent, at, pre, key }) => {
          const source = textOf(pre).replace(/\n$/, '')
          const markdown = await render(key, source).catch(() => null)
          if (markdown === null) return
          const answerContext = await withAnswerTargets(markdown, context, linkTargets)
          const children = (await toNodes(markdown, answerContext)).filter(
            (node): node is ElementContent => node.type !== 'doctype',
          )
          children.forEach(makeInert)
          const block: Element = {
            type: 'element',
            tagName: 'div',
            properties: { className: ['plugin-block'], dataPlugin: key },
            children,
          }
          if (pre.position) block.position = pre.position
          parent.children[at] = block
        }),
      )
    },
  }
}
