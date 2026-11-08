// Markdown to a sanitized HTML tree (hast) for the preview. Note content is untrusted (import, sync and AI write it too): raw HTML is parsed, then sanitized by an
// allowlist, and only then do preview renderers add Devot's own structure. The tree is plain data, so it crosses the worker boundary.
import type { Comment, Element, ElementContent, Root as HastRoot, RootContent } from 'hast'
import { textOf } from '../hastText'
import type { Root as MdastRoot, RootContent as MdastContent } from 'mdast'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema, type Options as Schema } from 'rehype-sanitize'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { BUILTIN_RENDERERS } from './builtins'
import { createBlockSplitter, type Block, type NoteSplit } from './blocks'
import {
  definitionsIn,
  labelsIn,
  likelyDefined,
  parseSeeded,
  remarkSeededLabels,
  type Definitions,
  type Label,
  type LinkDefinition,
  type NoteDefinition,
} from './definitions'
import {
  createNumbering,
  footnoteSection,
  takeFootnotes,
  withBackReferences,
  type PieceFootnotes,
  type PieceNote,
} from './footnotes'
import { createSlugger, headingIds, ID_PREFIX, slug as headingSlug } from './headingIds'
import { remarkHighlightMarks } from './highlightMarks'
import { remarkSoftBreaks } from './softBreaks'
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
  PIECE_OFFSET_PROPERTIES,
} from './registry'

export * from './registry'
export { videoEmbedUrl } from './videoEmbeds'
export {
  codeLanguage,
  createCodeRenderer,
  drawCodeMarks,
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
    .use(remarkSeededLabels)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkHighlightMarks)
    .use(remarkSoftBreaks)
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

function stripPositions(node: HastRoot | RootContent): void {
  delete node.position
  if ('children' in node) node.children.forEach(stripPositions)
}

/** `markdown` as a note's body (front matter is not read), sanitized, through `renderers` alone. */
export async function renderBody(
  markdown: string,
  options: PreviewOptions,
  renderers: readonly PreviewRenderer[],
): Promise<HastRoot> {
  const tree = await transformed(bodyProcessor, markdown, options, renderers)
  stripPositions(tree)
  return tree
}

async function transformed(
  parser: typeof processor,
  markdown: string,
  options: PreviewOptions,
  renderers: readonly PreviewRenderer[],
  mdast = parser.parse(markdown) as MdastRoot,
): Promise<HastRoot> {
  const head = mdast.children[0]
  const frontmatter = head?.type === 'yaml' ? head.value : null
  const tree = parser.runSync(mdast, markdown) as HastRoot
  const context = { ...options, frontmatter, source: markdown }
  for (const renderer of renderers) await renderer.transform(tree, context)
  return tree
}

/**
 * One piece of a note's preview (see blocks.ts). `nodes` are left out when
 * the caller already has a piece with this `key`. Lines and offsets in the
 * nodes (`data-source-line`, `data-task-at`, `data-image-from`/`-to`) count
 * from the piece's start: add `line - 1` and `offset` for the note's.
 * With `parts`, the elements carrying them, in document order, fall into
 * parts that each count from their own start instead: the list of notes has
 * a part per note, from where the note is defined, so text added above a
 * note moves its lines without sending the list again.
 */
export interface PreviewPiece {
  key: string
  line: number
  offset: number
  parts?: PiecePart[]
  nodes?: RootContent[]
}

export interface PiecePart {
  line: number
  offset: number
  /** How many of the piece's elements with a line or an offset are in this part. */
  marks: number
}

interface Rendered {
  id: number
  nodes: RootContent[]
  headings: { node: Element; slug: string }[]
  footnotes: PieceFootnotes
  length: number
  // What the text may refer to, and what it defines.
  labels: Label[]
  defines: Definitions
  // The definitions from other pieces it was rendered with.
  context: string
}

interface Parsed {
  labels: Label[]
  defines: Definitions
  tree: MdastRoot
  seeded: Label[]
}

// The definitions a piece uses from other pieces, as tree nodes.
interface PieceContext {
  key: string
  seeds: Label[]
  before: MdastContent[]
  after: MdastContent[]
  // Its own notes, called at its end so its render lists them.
  calls: MdastContent[]
}

/** Elements carrying a source line, and those carrying an offset into the note. */
export const PIECE_LINE_PROPERTY = 'dataSourceLine'

// The headings `headingIds` names, in its order, bar those in the list of notes a piece's render
// added: the note's list is named after all its pieces.
function unnamedHeadings(nodes: readonly RootContent[], out: Rendered['headings']): void {
  for (const node of nodes) {
    if (node.type !== 'element') continue
    if (
      node.tagName === 'section' &&
      !node.position &&
      node.properties['dataFootnotes'] !== undefined
    )
      continue
    if (HEADING.test(node.tagName) && node.properties['id'] === undefined) {
      out.push({ node, slug: headingSlug(textOf(node)) })
    }
    unnamedHeadings(node.children, out)
  }
}

function shift(node: RootContent | ElementContent, lines: number, chars: number): void {
  if (node.type !== 'element') return
  const line = node.properties[PIECE_LINE_PROPERTY]
  if (typeof line === 'number') node.properties[PIECE_LINE_PROPERTY] = line + lines
  for (const name of PIECE_OFFSET_PROPERTIES) {
    const value = node.properties[name]
    if (typeof value === 'number') node.properties[name] = value + chars
  }
  for (const child of node.children) shift(child, lines, chars)
}

// The elements in `node` with a line or an offset, as the page counts them for `PiecePart`.
function marksIn(node: RootContent | ElementContent): number {
  if (node.type !== 'element') return 0
  const own =
    typeof node.properties[PIECE_LINE_PROPERTY] === 'number' ||
    PIECE_OFFSET_PROPERTIES.some((name) => typeof node.properties[name] === 'number')
  let count = own ? 1 : 0
  for (const child of node.children) count += marksIn(child)
  return count
}

const HEADING = /^h[1-6]$/
// Shorter pieces cost more to set up than they save when one is rendered again.
export const PIECE_LENGTH = 2000

/**
 * Besides the pieces the note shows, the cache keeps pieces up to this many
 * characters of source: superseded versions of an edited piece (a count limit
 * kept hundreds, about 100 KB of tree each) and the notes shown before, so a
 * note left keeps little of its trees (about 100 bytes a character).
 */
export const KEPT_CHARACTERS = 50_000
// Footnotes whose last rendered item is kept to tell whether the next render changed it.
const KEPT_NOTE_VERSIONS = 2000

export interface PieceRenderer {
  (markdown: string, options: PreviewOptions, known?: readonly string[]): Promise<PreviewPiece[]>
  /** The preview closed: what it showed is kept only within the capacity, as a note left is. */
  forgetShown(): void
  /** Renders as for the preview, but leaves what the preview shows pinned and its render before alone. */
  sample(markdown: string, options: PreviewOptions): Promise<PreviewPiece[]>
}

// Past this many blocks changed, counting copies by text is cheaper than comparing.
const FEW_CHANGED = 16

/**
 * How many blocks before each have its text. After an edit of a few blocks, the blocks kept from
 * the split before (`was`) take their count from there, moved by the blocks that came or went.
 */
function copiesOf(
  blocks: readonly Block[],
  was: readonly number[],
  before: { blocks: readonly Block[]; copies: readonly number[] } | undefined,
): number[] {
  const kept = new Set(was)
  const gone = before?.blocks.filter((_, j) => !kept.has(j)).map((block) => block.text) ?? []
  const added = blocks.filter((_, i) => was[i]! < 0).map((block) => block.text)
  if (!before || gone.length + added.length > FEW_CHANGED) {
    const seen = new Map<string, number>()
    return blocks.map(({ text }) => {
      const copy = seen.get(text) ?? 0
      seen.set(text, copy + 1)
      return copy
    })
  }
  const among = (texts: readonly string[], text: string) =>
    texts.reduce((count, other) => (other === text ? count + 1 : count), 0)
  let changed = 0
  while (changed < blocks.length && was[changed] === changed) changed += 1
  return blocks.map(({ text }, i) => {
    const j = was[i]!
    if (j >= 0 && i < changed) return before.copies[j]!
    if (j >= 0) return before.copies[j]! - among(gone, text) + among(added, text)
    let copy = 0
    for (let k = 0; k < i; k += 1) if (blocks[k]!.text === text) copy += 1
    return copy
  })
}

/**
 * `renderPreview` cut into pieces: only pieces whose text (or rendering
 * options) changed are rendered again. Heading ids depend on the headings
 * before them, so they are named across the whole note on every call.
 */
export function createPieceRenderer({
  registry = defaultRegistry,
  capacity = KEPT_CHARACTERS,
  pieceLength = PIECE_LENGTH,
  split = createBlockSplitter(pieceLength),
}: {
  registry?: PreviewRegistry
  capacity?: number
  pieceLength?: number
  /** Cuts the note into pieces; one that remembers the note before cuts an edited note again only around the edit. */
  split?: (markdown: string) => NoteSplit
} = {}): PieceRenderer {
  const cache = new Map<string, Rendered>()
  let cached = 0
  let ids = 0
  // A render under way when the preview closes shows nothing.
  let closings = 0
  let shown: ReadonlySet<string> = new Set()
  const splitSample = createBlockSplitter(pieceLength)
  const noteVersions = new Map<string, { shape: string; version: number }>()

  // Pieces with the same text get nodes of their own (their heading ids differ).
  const keyOf = (text: string, first: boolean, copy: number, optionsKey: string) =>
    `${first ? 1 : 0} ${copy} ${optionsKey}\u0000${text}`
  // The render before, whose keys the pieces it kept take again rather than building them from
  // their whole text.
  let last: { blocks: Block[]; copies: number[]; keys: string[]; options: string } | undefined

  // Drops the oldest pieces the note does not show right now, until the others fit. A piece it
  // shows is never dropped, or a note larger than the cache would render whole again on every
  // keystroke. The versions of notes no kept piece defines go with them: they hold the notes' text.
  const trim = () => {
    let others = cached
    for (const key of shown) others -= cache.get(key)?.length ?? 0
    for (const [key, { length }] of cache) {
      if (others <= capacity) break
      if (shown.has(key)) continue
      cache.delete(key)
      cached -= length
      others -= length
    }
    if (noteVersions.size === 0) return
    const defined = new Set<string>()
    for (const { footnotes } of cache.values()) {
      for (const note of footnotes.notes) defined.add(note.id)
    }
    for (const id of noteVersions.keys()) if (!defined.has(id)) noteVersions.delete(id)
  }

  const renderPiece = async (
    key: string,
    text: string,
    first: boolean,
    options: PreviewOptions,
    parsed: Parsed,
    context: PieceContext,
  ): Promise<Rendered> => {
    const headings: Rendered['headings'] = []
    // Stands in for `headingIds`, so heading text is read where it would be.
    const collect: PreviewRenderer = {
      id: headingIds.id,
      apiVersion: PREVIEW_API_VERSION,
      transform: (tree) => unnamedHeadings(tree.children, headings),
    }
    const renderers = registry.renderers().map((r) => (r === headingIds ? collect : r))
    const mdast = parsed.tree
    const head = mdast.children[0]
    mdast.children = [
      ...(head?.type === 'yaml' ? [head] : []),
      ...context.before,
      ...mdast.children.slice(head?.type === 'yaml' ? 1 : 0),
      ...context.after,
      ...(context.calls.length > 0
        ? [{ type: 'paragraph', children: context.calls } as MdastContent]
        : []),
    ]
    const tree = await transformed(
      first ? processor : bodyProcessor,
      text,
      options,
      renderers,
      mdast,
    )
    const footnotes = takeFootnotes(tree, markLinesAndStripPositions)
    for (const note of footnotes.notes) {
      // Counted from the note's own start, an item stays the same when text before it changes.
      shift(note.item, 1 - note.line, -note.offset)
      const shape = JSON.stringify(note.item)
      const known = noteVersions.get(note.id)
      const version = known?.shape === shape ? known.version : (ids += 1)
      noteVersions.delete(note.id)
      noteVersions.set(note.id, { shape, version })
      note.version = version
      note.marks = marksIn(note.item)
      const named: Rendered['headings'] = []
      unnamedHeadings(note.item.children, named)
      note.headings = named.map((heading) => heading.slug)
    }
    for (const id of noteVersions.keys()) {
      if (noteVersions.size <= KEPT_NOTE_VERSIONS) break
      noteVersions.delete(id)
    }
    const rendered: Rendered = {
      id: (ids += 1),
      nodes: tree.children,
      headings,
      footnotes,
      length: text.length,
      labels: parsed.labels,
      defines: parsed.defines,
      context: context.key,
    }
    const old = cache.get(key)
    if (old) {
      cache.delete(key)
      cached -= old.length
    }
    cache.set(key, rendered)
    cached += text.length
    return rendered
  }

  const render = async (
    markdown: string,
    options: PreviewOptions,
    known: readonly string[] = [],
    showing = true,
  ) => {
    const opened = closings
    const names = registry.renderers().includes(headingIds)
    const { blocks, was: wasAt } = (showing ? split : splitSample)(markdown)
    // Only front matter shows the note's fields: other pieces do not render again when those change.
    const { note: fields, ...bodyOptions } = options
    const bodyKey = JSON.stringify(bodyOptions)
    const front = fields !== undefined && markdown.startsWith('---')
    const firstKey = front ? JSON.stringify(options) : bodyKey
    const before = showing ? last : undefined
    const copies = copiesOf(blocks, wasAt, before)
    const sameOptions = before?.options === `${firstKey}\u0000${bodyKey}`
    const keys = blocks.map((block, i) => {
      const j = wasAt[i]!
      if (sameOptions && j >= 0 && (i === 0) === (j === 0) && before!.copies[j] === copies[i]) {
        return before!.keys[j]!
      }
      return keyOf(block.text, i === 0, copies[i]!, i === 0 ? firstKey : bodyKey)
    })
    if (showing) last = { blocks, copies, keys, options: `${firstKey}\u0000${bodyKey}` }
    const parserOf = (i: number) => (i === 0 ? processor : bodyProcessor)

    const found = keys.map((key) => {
      const entry = cache.get(key)
      if (entry) {
        cache.delete(key)
        cache.set(key, entry)
      }
      return entry
    })
    // New pieces are parsed knowing the labels the others define; a guess is parsed again below.
    const assumed = new Set<Label>()
    for (const entry of found) {
      if (!entry) continue
      for (const label of entry.defines.links.keys()) assumed.add(label)
      for (const label of entry.defines.notes.keys()) assumed.add(label)
    }
    for (const [i, block] of blocks.entries()) {
      if (!found[i]) for (const label of likelyDefined(block.text)) assumed.add(label)
    }
    const parse = (i: number, labels: Label[], seeded: Label[]): Parsed => {
      const tree = parseSeeded(parserOf(i), blocks[i]!.text, seeded)
      return { labels, defines: definitionsIn(tree), tree, seeded }
    }
    const parsed = blocks.map((block, i) => {
      if (found[i]) return undefined
      const labels = labelsIn(block.text)
      return parse(
        i,
        labels,
        labels.filter((label) => assumed.has(label)),
      )
    })
    const summary = (i: number) => (found[i] ?? parsed[i])!

    // The note's definition of a label is its first.
    const owner = new Map<Label, number>()
    const links = new Map<Label, LinkDefinition>()
    const notes = new Map<Label, NoteDefinition>()
    for (const i of blocks.keys()) {
      const { defines } = summary(i)
      for (const [label, node] of defines.links) {
        if (owner.has(label)) continue
        owner.set(label, i)
        links.set(label, node)
      }
      for (const [label, node] of defines.notes) {
        if (owner.has(label)) continue
        owner.set(label, i)
        notes.set(label, node)
      }
    }
    const contextOf = (i: number, labels: readonly Label[]): PieceContext => {
      const context: PieceContext = { key: '', seeds: [], before: [], after: [], calls: [] }
      const parts: string[] = []
      for (const label of labels) {
        const at = owner.get(label)
        if (at === undefined) continue
        const note = notes.get(label)
        if (at === i) {
          if (note) {
            context.calls.push({
              type: 'footnoteReference',
              identifier: note.identifier,
              label: note.label,
            })
          }
          continue
        }
        context.seeds.push(label)
        const side = at < i ? context.before : context.after
        const where = at < i ? '<' : '>'
        if (note) {
          side.push({
            type: 'footnoteDefinition',
            identifier: note.identifier,
            label: note.label,
            children: [],
          })
          parts.push(label + where)
        } else {
          const link = links.get(label)!
          side.push({
            type: 'definition',
            identifier: link.identifier,
            label: link.label,
            url: link.url,
            title: link.title,
          })
          parts.push(`${label}\u0001${link.url}\u0001${link.title ?? ''}${where}`)
        }
      }
      context.key = parts.join('\u0002')
      return context
    }
    // Whether a parse with `seeded` reads the text as one with `seeds` would.
    const sameSeeds = (fresh: Parsed, seeds: readonly Label[]) => {
      const own = (label: Label) => fresh.defines.links.has(label) || fresh.defines.notes.has(label)
      const was = fresh.seeded.filter((label) => !own(label))
      const now = seeds.filter((label) => !own(label))
      return was.length === now.length && now.every((label) => was.includes(label))
    }

    const rendered: Rendered[] = []
    try {
      for (const [i, block] of blocks.entries()) {
        const { labels } = summary(i)
        const context = contextOf(i, labels)
        const entry = found[i]
        if (entry && entry.context === context.key) {
          rendered.push(entry)
          continue
        }
        const fresh = parsed[i]
        const tree =
          fresh && sameSeeds(fresh, context.seeds) ? fresh : parse(i, labels, context.seeds)
        const pieceOptions = i === 0 && front ? options : bodyOptions
        rendered.push(await renderPiece(keys[i]!, block.text, i === 0, pieceOptions, tree, context))
      }
    } finally {
      if (showing) shown = opened === closings ? new Set(keys) : new Set()
      trim()
    }

    const have = new Set(known)
    const next = names ? createSlugger() : undefined
    const numbering = createNumbering()
    const pieces = blocks.map((block, i) => {
      const { id, nodes, headings, footnotes } = rendered[i]!
      let key = String(id)
      if (next) {
        const named = headings.map(({ node, slug: base }) => {
          const slug = next(base)
          if (slug) node.properties['id'] = ID_PREFIX + slug
          else delete node.properties['id']
          return slug
        })
        if (named.length > 0) key += `#${named.join('\u0000')}`
      }
      if (footnotes.calls.length > 0) {
        key += `^${footnotes.calls.map((call) => numbering.number(call)).join(',')}`
      }
      const out: PreviewPiece = { key, line: block.line, offset: block.offset }
      if (!have.has(key)) out.nodes = i > 0 && nodes.length > 0 ? [LINE_BREAK, ...nodes] : nodes
      return out
    })

    // The list of notes ends the note, in the order of their first calls.
    const defining = new Map<string, { piece: number; note: PieceNote }>()
    for (const [piece, { footnotes }] of rendered.entries()) {
      for (const note of footnotes.notes)
        if (!defining.has(note.id)) defining.set(note.id, { piece, note })
    }
    const listed: {
      piece: number
      note: PieceNote
      index: number
      count: number
      calls: string
    }[] = []
    for (let index = 0; index < numbering.order.length; index += 1) {
      const id = numbering.order[index]!
      const defined = defining.get(id)
      if (!defined) continue
      const calls = defined.note.calls.map((call) => numbering.number(call)).join(',')
      listed.push({ ...defined, index, count: numbering.counts.get(id)!, calls })
    }
    if (listed.length === 0) return pieces
    const named = listed.map(({ note }) => (next ? note.headings.map((base) => next(base)) : []))
    const key = `notes ${listed
      .map(
        ({ note, index, count, calls }, at) =>
          `${note.version}.${index}.${count}.${calls}.${named[at]!.join('\u0001')}`,
      )
      .join('\u0000')}`
    const shape = rendered[listed[0]!.piece]!.footnotes.section!
    const parts = listed.map(({ piece, note }) => {
      const { line, offset } = blocks[piece]!
      return { line: line + note.line - 1, offset: offset + note.offset, marks: note.marks }
    })
    // The section around the notes counts with the first.
    parts[0]!.marks += marksIn(shape)
    const footer: PreviewPiece = { key, line: parts[0]!.line, offset: parts[0]!.offset, parts }
    if (!have.has(key)) {
      const items = listed.map(({ note, index, count }, at) => {
        const item = structuredClone(note.item)
        const headings: Rendered['headings'] = []
        unnamedHeadings(item.children, headings)
        for (const [h, { node }] of headings.entries()) {
          const slug = named[at]![h]
          if (slug) node.properties['id'] = ID_PREFIX + slug
          else delete node.properties['id']
        }
        withBackReferences(item, note, index, count)
        return item
      })
      footer.nodes = [LINE_BREAK, footnoteSection(shape, items)]
    }
    return [...pieces, footer]
  }
  return Object.assign(render, {
    forgetShown: () => {
      closings += 1
      shown = new Set()
      trim()
    },
    sample: (markdown: string, options: PreviewOptions) => render(markdown, options, [], false),
  })
}

/** remark-rehype's separator between top-level blocks. */
const LINE_BREAK: RootContent = { type: 'text', value: '\n' }

export const renderPreviewPieces = createPieceRenderer()
