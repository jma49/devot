// Markdown to a sanitized HTML tree (hast) for the preview. Note content is untrusted (import, sync and AI write it too): raw HTML is parsed, then sanitized by an
// allowlist, and only then do preview renderers add Devot's own structure. The tree is plain data, so it crosses the worker boundary.
import type { Element, Root as HastRoot, RootContent } from 'hast'
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
import { splitBlocks } from './blocks'
import { createSlugger, headingIds } from './headingIds'
import {
  createRegistry,
  PREVIEW_API_VERSION,
  type PreviewOptions,
  type PreviewRegistry,
  type PreviewRenderer,
} from './registry'

export * from './registry'
export { videoEmbedUrl } from './builtins'
export {
  codeLanguage,
  createCodeRenderer,
  parseCodeInfo,
  type CodeInfo,
  type Highlighter,
} from './code'
export { createEmojiRenderer, type EmojiTable } from './emoji'
export { createMathRenderer, type MathEngine } from './math'

/** GitHub's schema plus `mark`, https iframes and devot:// URLs. Math arrives as `code.language-math` and is rendered after sanitizing. */
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

const remark = () =>
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    // Front matter is shown by the `devot.frontmatter` renderer, not as text.
    .use(remarkRehype, { allowDangerousHtml: true, handlers: { yaml: () => undefined } })
    .use(rehypeRaw)
    .use(rehypeSanitize, schema)

const processor = remark().use(remarkFrontmatter, ['yaml']).freeze()
/** For the pieces after a note's first: front matter only opens a note. */
const bodyProcessor = remark().freeze()

export function createPreviewRegistry(options: { builtins?: boolean } = {}): PreviewRegistry {
  return createRegistry(options.builtins ? BUILTIN_RENDERERS : [])
}

const defaultRegistry = createPreviewRegistry({ builtins: true })

/** Each gets the source line it starts on (`data-source-line`), so the editor and the preview can scroll together; inline elements do not, since a paragraph reflows its lines. */
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

/** Runs after the renderers (they keep a replaced block's position) and after sanitizing, so a note can never set the attribute itself. */
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
  const tree = await transformed(processor, markdown, options, registry.renderers())
  markLinesAndStripPositions(tree)
  return tree
}

async function transformed(
  parser: typeof processor,
  markdown: string,
  options: PreviewOptions,
  renderers: readonly PreviewRenderer[],
): Promise<HastRoot> {
  const mdast = parser.parse(markdown) as MdastRoot
  const head = mdast.children[0]
  const frontmatter = head?.type === 'yaml' ? head.value : null
  const tree = parser.runSync(mdast) as HastRoot
  const context = { ...options, frontmatter, source: markdown }
  for (const renderer of renderers) await renderer.transform(tree, context)
  return tree
}

/**
 * One piece of a note's preview (see blocks.ts). `nodes` are left out when
 * the caller already has a piece with this `key`. Lines and offsets in the
 * nodes (`data-source-line`, `data-task-at`, `data-image-from`/`-to`) count
 * from the piece's start: add `line - 1` and `offset` for the note's.
 */
export interface PreviewPiece {
  key: string
  line: number
  offset: number
  nodes?: RootContent[]
}

interface Rendered {
  id: number
  nodes: RootContent[]
  headings: { node: Element; text: string }[]
}

/** Elements carrying a source line, and those carrying an offset into the note. */
export const PIECE_LINE_PROPERTY = 'dataSourceLine'
export const PIECE_OFFSET_PROPERTIES = ['dataTaskAt', 'dataImageFrom', 'dataImageTo'] as const

function textOf(node: RootContent): string {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map(textOf).join('') : ''
}

/** The headings `headingIds` names, in its order. */
function unnamedHeadings(nodes: readonly RootContent[], out: Rendered['headings']): void {
  for (const node of nodes) {
    if (node.type !== 'element') continue
    if (HEADING.test(node.tagName) && node.properties['id'] === undefined) {
      out.push({ node, text: textOf(node) })
    }
    unnamedHeadings(node.children, out)
  }
}

const HEADING = /^h[1-6]$/
/** Shorter pieces cost more to set up than they save when one is rendered again. */
const PIECE_LENGTH = 2000

/**
 * `renderPreview` cut into pieces: only pieces whose text (or rendering
 * options) changed are rendered again. Heading ids depend on the headings
 * before them, so they are named across the whole note on every call.
 */
export function createPieceRenderer({
  registry = defaultRegistry,
  capacity = 1000,
  pieceLength = PIECE_LENGTH,
}: { registry?: PreviewRegistry; capacity?: number; pieceLength?: number } = {}): (
  markdown: string,
  options: PreviewOptions,
  known?: readonly string[],
) => Promise<PreviewPiece[]> {
  const cache = new Map<string, Rendered>()
  let ids = 0

  const piece = async (
    text: string,
    first: boolean,
    copy: number,
    options: PreviewOptions,
    optionsKey: string,
  ): Promise<Rendered> => {
    // Pieces with the same text get nodes of their own (their heading ids differ).
    const key = `${first ? 1 : 0} ${copy} ${optionsKey}\u0000${text}`
    const found = cache.get(key)
    if (found) {
      cache.delete(key)
      cache.set(key, found)
      return found
    }
    const headings: Rendered['headings'] = []
    // Stands in for `headingIds`, so heading text is read where it would be.
    const collect: PreviewRenderer = {
      id: headingIds.id,
      apiVersion: PREVIEW_API_VERSION,
      transform: (tree) => unnamedHeadings(tree.children, headings),
    }
    const renderers = registry.renderers().map((r) => (r === headingIds ? collect : r))
    const tree = await transformed(first ? processor : bodyProcessor, text, options, renderers)
    markLinesAndStripPositions(tree)
    const rendered = { id: (ids += 1), nodes: tree.children, headings }
    cache.set(key, rendered)
    if (cache.size > capacity) cache.delete(cache.keys().next().value!)
    return rendered
  }

  return async (markdown, options, known = []) => {
    const names = registry.renderers().includes(headingIds)
    const optionsKey = JSON.stringify(options)
    const blocks = splitBlocks(markdown, pieceLength)
    const rendered: Rendered[] = []
    const copies = new Map<string, number>()
    for (const [i, block] of blocks.entries()) {
      const copy = copies.get(block.text) ?? 0
      copies.set(block.text, copy + 1)
      rendered.push(await piece(block.text, i === 0, copy, options, optionsKey))
    }
    const have = new Set(known)
    const next = names ? createSlugger() : undefined
    return blocks.map((block, i) => {
      const { id, nodes, headings } = rendered[i]!
      let key = String(id)
      if (next) {
        const named = headings.map(({ node, text }) => {
          const slug = next(text)
          if (slug) node.properties['id'] = slug
          else delete node.properties['id']
          return slug
        })
        if (named.length > 0) key += `#${named.join('\u0000')}`
      }
      const out: PreviewPiece = { key, line: block.line, offset: block.offset }
      if (!have.has(key)) out.nodes = i > 0 && nodes.length > 0 ? [LINE_BREAK, ...nodes] : nodes
      return out
    })
  }
}

/** remark-rehype's separator between top-level blocks. */
const LINE_BREAK: RootContent = { type: 'text', value: '\n' }

export const renderPreviewPieces = createPieceRenderer()
