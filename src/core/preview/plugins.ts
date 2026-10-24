// Plugins' preview renderers (ADR 0005): a fenced code block in a plugin's language goes to the plugin, which answers Markdown.
// The answer is rendered and sanitized like note text, so a plugin adds only what a note could; a block without an answer stays code.
import type { Element, ElementContent, Root, RootContent } from 'hast'
import { PREVIEW_API_VERSION, type PreviewContext, type PreviewRenderer } from './registry'

export interface PluginRendererSpec {
  /** Names the renderer to the host (`<plugin id>/<renderer id>`). */
  key: string
  language: string
}

export type RenderPluginBlock = (key: string, source: string) => Promise<string | null>

export type MarkdownNodes = (markdown: string, context: PreviewContext) => Promise<RootContent[]>

const textOf = (node: RootContent): string =>
  node.type === 'text' ? node.value : 'children' in node ? node.children.map(textOf).join('') : ''

function languageOf(pre: Element): { code: Element; language: string } | undefined {
  const [code, ...rest] = pre.children
  if (rest.length > 0 || code?.type !== 'element' || code.tagName !== 'code') return undefined
  const names = code.properties['className']
  const name = Array.isArray(names)
    ? names.find((n) => typeof n === 'string' && n.startsWith('language-'))
    : undefined
  return typeof name === 'string' ? { code, language: name.slice('language-'.length) } : undefined
}

function stripPositions(node: RootContent): void {
  delete node.position
  if ('children' in node) node.children.forEach(stripPositions)
}

export function createPluginRenderer(
  specs: readonly PluginRendererSpec[],
  render: RenderPluginBlock,
  toNodes: MarkdownNodes,
): PreviewRenderer {
  const byLanguage = new Map(specs.map((s) => [s.language, s.key]))
  return {
    id: 'devot.plugins',
    apiVersion: PREVIEW_API_VERSION,
    async transform(tree: Root, context: PreviewContext) {
      const found: { parent: Root | Element; at: number; pre: Element; key: string }[] = []
      const walk = (parent: Root | Element) => {
        parent.children.forEach((child, at) => {
          if (child.type !== 'element') return
          const block = child.tagName === 'pre' ? languageOf(child) : undefined
          const key = block && byLanguage.get(block.language)
          if (block && key) found.push({ parent, at, pre: child, key })
          else walk(child)
        })
      }
      walk(tree)
      await Promise.all(
        found.map(async ({ parent, at, pre, key }) => {
          const source = textOf(pre).replace(/\n$/, '')
          const markdown = await render(key, source).catch(() => null)
          if (markdown === null) return
          const children = (await toNodes(markdown, context)).filter(
            (node): node is ElementContent => node.type !== 'doctype',
          )
          children.forEach(stripPositions)
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
