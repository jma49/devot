// Markdown to a sanitized HTML tree (hast) for the preview. Note content is untrusted (import, sync and AI write it too): raw HTML is parsed, then sanitized by an
// allowlist, and only then do preview renderers add Devot's own structure. The tree is plain data, so it crosses the worker boundary.
import type { Comment, Element, ElementContent, Root as HastRoot, RootContent } from 'hast'
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
import { createSlugger, headingIds, ID_PREFIX } from './headingIds'
import {
  createPluginRenderer,
  type MarkdownNodes,
  type PluginRendererSpec,
  type RenderPluginBlock,
} from './plugins'
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
export type { PluginRendererSpec, RenderPluginBlock } from './plugins'

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

/** A plugin has no network permission, so its answer loads nothing remote: images only from data:, blob: and devot:, links only to notes, no frames. */
const pluginSchema: Schema = {
  ...schema,
  tagNames: (schema.tagNames ?? []).filter((name) => name !== 'iframe'),
  protocols: { ...schema.protocols, href: ['devot'], src: ['data', 'blob', 'devot'] },
}

const remark = (sanitize: Schema = schema) =>
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    // Front matter is shown by the `devot.frontmatter` renderer, not as text.
    // The sanitizer adds the one clobber prefix (`user-content-`): a second one
    // here would leave footnote ids out of reach of their links.
    .use(remarkRehype, {
      allowDangerousHtml: true,
      clobberPrefix: '',
      handlers: { yaml: () => undefined },
    })
    .use(rehypeRaw)
    .use(rehypeSanitize, sanitize)

const processor = remark().use(remarkFrontmatter, ['yaml']).freeze()
/** For the pieces after a note's first: front matter only opens a note. */
const bodyProcessor = remark().freeze()
const pluginProcessor = remark(pluginSchema).freeze()

export function createPreviewRegistry(
  options: {
    builtins?: boolean
    plugins?: { specs: readonly PluginRendererSpec[]; render: RenderPluginBlock }
  } = {},
): PreviewRegistry {
  const builtins = options.builtins ? BUILTIN_RENDERERS : []
  const plugins = options.plugins
  if (!plugins || plugins.specs.length === 0) return createRegistry(builtins)
  // A plugin's answer is rendered like note text, by the built-in renderers alone; its headings are named with the note's.
  const inner = builtins.filter((r) => r !== headingIds)
  const toNodes: MarkdownNodes = async (markdown, context) =>
    (await transformed(pluginProcessor, markdown, context, inner)).children
  return createRegistry([
    createPluginRenderer(plugins.specs, plugins.render, toNodes),
    // Heading ids still reach an answer's headings; every other built-in has
    // run over it already (code blocks, swatches).
    ...builtins.map((r) => (r === headingIds ? r : outsidePluginBlocks(r))),
  ])
}

const isPluginBlock = (node: Element): boolean => {
  const names = node.properties['className']
  return Array.isArray(names) && names.map(String).includes('plugin-block')
}

/**
 * A built-in renderer that leaves plugin blocks alone: the block's answer was
 * rendered by the built-ins already, and a second pass would put a code block
 * inside a code block's header and a swatch on every swatch.
 */
function outsidePluginBlocks(renderer: PreviewRenderer): PreviewRenderer {
  return {
    id: renderer.id,
    apiVersion: renderer.apiVersion,
    async transform(tree, context) {
      // A placeholder keeps the block's place through a renderer that moves, rebuilds or prepends nodes around it.
      const held = new Map<Comment, Element>()
      const take = (parent: HastRoot | Element) => {
        parent.children.forEach((child, at) => {
          if (child.type !== 'element') return
          if (!isPluginBlock(child)) return take(child)
          const placeholder: Comment = { type: 'comment', value: 'plugin-block' }
          held.set(placeholder, child)
          ;(parent as { children: ElementContent[] }).children[at] = placeholder
        })
      }
      const restore = (parent: HastRoot | Element) => {
        parent.children.forEach((child, at) => {
          if (child.type === 'comment') {
            const node = held.get(child)
            if (node) (parent as { children: ElementContent[] }).children[at] = node
          } else if (child.type === 'element') restore(child)
        })
      }
      take(tree)
      try {
        await renderer.transform(tree, context)
      } finally {
        restore(tree)
      }
    },
  }
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
  length: number
}

/** Elements carrying a source line, and those carrying an offset into the note. */
export const PIECE_LINE_PROPERTY = 'dataSourceLine'

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
/**
 * The cache holds pieces up to this many characters of source in all: every
 * keystroke in Split view makes a new version of one piece, and a count limit
 * kept hundreds of superseded versions (about 100 KB of tree each).
 */
const CACHE_CHARACTERS = 300_000

export function createPieceRenderer({
  registry = defaultRegistry,
  capacity = CACHE_CHARACTERS,
  pieceLength = PIECE_LENGTH,
}: { registry?: PreviewRegistry; capacity?: number; pieceLength?: number } = {}): (
  markdown: string,
  options: PreviewOptions,
  known?: readonly string[],
) => Promise<PreviewPiece[]> {
  const cache = new Map<string, Rendered>()
  let cached = 0
  let ids = 0

  /** Pieces with the same text get nodes of their own (their heading ids differ). */
  const keyOf = (text: string, first: boolean, copy: number, optionsKey: string) =>
    `${first ? 1 : 0} ${copy} ${optionsKey}\u0000${text}`

  /**
   * Drops the oldest pieces the note does not show right now, until the cache
   * fits. A piece it shows is never dropped, or a note larger than the cache
   * would render whole again on every keystroke.
   */
  const trim = (shown: ReadonlySet<string>) => {
    for (const [key, { length }] of cache) {
      if (cached <= capacity) return
      if (shown.has(key)) continue
      cache.delete(key)
      cached -= length
    }
  }

  const piece = async (
    key: string,
    text: string,
    first: boolean,
    options: PreviewOptions,
  ): Promise<Rendered> => {
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
    const rendered = { id: (ids += 1), nodes: tree.children, headings, length: text.length }
    cache.set(key, rendered)
    cached += text.length
    return rendered
  }

  return async (markdown, options, known = []) => {
    const names = registry.renderers().includes(headingIds)
    const blocks = splitBlocks(markdown, pieceLength)
    // Only front matter shows the note's fields: other pieces do not render again when those change.
    const { note, ...bodyOptions } = options
    const bodyKey = JSON.stringify(bodyOptions)
    const front = note !== undefined && markdown.startsWith('---')
    const firstKey = front ? JSON.stringify(options) : bodyKey
    const copies = new Map<string, number>()
    const keys = blocks.map((block, i) => {
      const copy = copies.get(block.text) ?? 0
      copies.set(block.text, copy + 1)
      return keyOf(block.text, i === 0, copy, i === 0 ? firstKey : bodyKey)
    })
    const rendered: Rendered[] = []
    try {
      for (const [i, block] of blocks.entries()) {
        const pieceOptions = i === 0 && front ? options : bodyOptions
        rendered.push(await piece(keys[i]!, block.text, i === 0, pieceOptions))
      }
    } finally {
      trim(new Set(keys))
    }
    const have = new Set(known)
    const next = names ? createSlugger() : undefined
    return blocks.map((block, i) => {
      const { id, nodes, headings } = rendered[i]!
      let key = String(id)
      if (next) {
        const named = headings.map(({ node, text }) => {
          const slug = next(text)
          if (slug) node.properties['id'] = ID_PREFIX + slug
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
