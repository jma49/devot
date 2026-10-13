// Markdown to a sanitized HTML tree (hast) for the preview. Note content is
// untrusted (import, sync and AI write it too): raw HTML is parsed, then
// sanitized by an allowlist, and only then do preview renderers add Devot's
// own structure. The tree is plain data, so it crosses the worker boundary.
import type { Root as HastRoot, RootContent } from 'hast'
import type { Root as MdastRoot } from 'mdast'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema, type Options as Schema } from 'rehype-sanitize'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { BUILTIN_RENDERERS } from './builtins'
import { createRegistry, type PreviewOptions, type PreviewRegistry } from './registry'

export * from './registry'
export { videoEmbedUrl } from './builtins'
export { createEmojiRenderer, type EmojiTable } from './emoji'
export { createMathRenderer, type MathEngine } from './math'

/**
 * The allowlist: GitHub's schema plus `mark`, https iframes and devot:// URLs.
 * Math arrives as `code.language-math` (kept by the schema) and is rendered
 * after sanitizing.
 */
const schema: Schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'mark', 'iframe'],
  attributes: { ...defaultSchema.attributes, iframe: ['src', 'title', 'width', 'height'] },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto', 'devot'],
    src: ['http', 'https', 'devot'],
  },
}

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkGfm)
  .use(remarkMath)
  // Front matter is shown by the `devot.frontmatter` renderer, not as text.
  .use(remarkRehype, { allowDangerousHtml: true, handlers: { yaml: () => undefined } })
  .use(rehypeRaw)
  .use(rehypeSanitize, schema)
  .freeze()

/** A registry; `builtins` adds Devot's own renderers first. */
export function createPreviewRegistry(options: { builtins?: boolean } = {}): PreviewRegistry {
  return createRegistry(options.builtins ? BUILTIN_RENDERERS : [])
}

const defaultRegistry = createPreviewRegistry({ builtins: true })

/**
 * Elements that show as blocks of their own. Each gets the source line it
 * starts on (`data-source-line`), so the editor and the preview can scroll
 * together; inline elements do not, since a paragraph reflows its lines.
 */
const BLOCKS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'dd',
  'div',
  'dl',
  'dt',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tr',
  'ul',
])

/**
 * Marks blocks with their source line, then drops every position. It runs
 * after the renderers (they keep a replaced block's position), and after
 * sanitizing, so a note can never set the attribute itself.
 */
function markLinesAndStripPositions(node: HastRoot | RootContent): void {
  if (node.type === 'element' && BLOCKS.has(node.tagName) && node.position) {
    node.properties['dataSourceLine'] = node.position.start.line
  }
  delete node.position
  if ('children' in node) node.children.forEach(markLinesAndStripPositions)
}

export async function renderPreview(
  markdown: string,
  options: PreviewOptions,
  registry: PreviewRegistry = defaultRegistry,
): Promise<HastRoot> {
  const mdast = processor.parse(markdown) as MdastRoot
  const head = mdast.children[0]
  const frontmatter = head?.type === 'yaml' ? head.value : null
  const tree = processor.runSync(mdast) as HastRoot
  const context = { ...options, frontmatter, source: markdown }
  for (const renderer of registry.renderers()) await renderer.transform(tree, context)
  markLinesAndStripPositions(tree)
  return tree
}
