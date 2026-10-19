// The editor's Markdown: the GFM dialect plus YAML front matter, which the
// preview and import read too (remark-frontmatter). Front matter is a block
// of lines between two `---` fences at the very start of a note; nothing
// inside it is Markdown, so the key lines above the closing fence never read
// as a setext heading, and formats leave its lines alone.
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import {
  HighlightStyle,
  Language,
  LanguageSupport,
  defineLanguageFacet,
  languageDataProp,
} from '@codemirror/language'
import type { Text } from '@codemirror/state'
import {
  NodeType,
  Parser,
  Tree,
  type Input,
  type PartialParse,
  type TreeFragment,
} from '@lezer/common'
import { Tag, styleTags, tags } from '@lezer/highlight'
import { BlockContext, type MarkdownConfig, type MarkdownParser } from '@lezer/markdown'
import { FRONT_MATTER_FENCE as FENCE } from '../../../core/readable'
import { leaveMarkupKeys } from './enter'

export const FRONT_MATTER = 'FrontMatter'

export const frontMatterTags = {
  content: Tag.define(tags.meta),
  mark: Tag.define(tags.processingInstruction),
}

const READ_CHUNK = 4096

/**
 * The first fence line that starts at `start` or later, up to a line that
 * starts at `limit`, as its start and end. Null when there is none.
 */
function fenceLine(
  input: Input,
  start: number,
  limit = input.length,
): { from: number; to: number } | null {
  let lineStart = start
  let read = start
  let buffer = ''
  while (lineStart <= limit) {
    const nl = buffer.indexOf('\n')
    if (nl < 0 && read < input.length) {
      const next = Math.min(input.length, read + READ_CHUNK)
      buffer += input.read(read, next)
      read = next
      continue
    }
    const text = nl < 0 ? buffer : buffer.slice(0, nl)
    if (FENCE.test(text)) return { from: lineStart, to: lineStart + text.length }
    if (nl < 0) return null
    buffer = buffer.slice(nl + 1)
    lineStart += nl + 1
  }
  return null
}

function lineStartAt(input: Input, pos: number): number {
  for (let at = pos; at > 0;) {
    const from = Math.max(0, at - READ_CHUNK)
    const nl = input.read(from, at).lastIndexOf('\n')
    if (nl >= 0) return from + nl + 1
    at = from
  }
  return 0
}

/**
 * Front matter's own language data, which has none of Markdown's helpers:
 * pasting a URL as a link, continuing lists and quotes, and completing HTML
 * tags all check that Markdown is the language at the cursor.
 */
const frontMatterData = defineLanguageFacet()

const contentType = NodeType.define({
  id: 0,
  name: 'FrontMatterContent',
  top: true,
  props: [
    [languageDataProp, frontMatterData],
    styleTags({ FrontMatterContent: frontMatterTags.content }),
  ],
})

// The input of each parse whose positions are the note's own (one range
// from its start), for the block parser to look ahead for the closing fence.
const inputs = new WeakMap<BlockContext, Input>()

export const FrontMatter: MarkdownConfig = {
  defineNodes: [{ name: FRONT_MATTER, block: true }, { name: 'FrontMatterMark' }],
  props: [
    styleTags({ [FRONT_MATTER]: frontMatterTags.content, FrontMatterMark: frontMatterTags.mark }),
  ],
  parseBlock: [
    {
      name: FRONT_MATTER,
      before: 'HorizontalRule',
      parse(cx, line) {
        const top = cx.parentType().name === 'Document'
        if (cx.lineStart !== 0 || !top || line.pos !== 0 || !FENCE.test(line.text)) return false
        const input = inputs.get(cx)
        const content = line.text.length + 1
        const close = input && fenceLine(input, content)
        if (!close) return false
        while (cx.lineStart < close.from) if (!cx.nextLine()) break
        cx.nextLine()
        const children = [cx.elt('FrontMatterMark', 0, 3)]
        if (close.from - 1 > content)
          children.push(cx.elt(new Tree(contentType, [], [], close.from - 1 - content), content))
        children.push(cx.elt('FrontMatterMark', close.from, close.from + 3))
        cx.addElement(cx.elt(FRONT_MATTER, 0, close.to, children))
        return true
      },
    },
  ],
  // Wrappers run in the order they were configured; the first one gets the
  // block parse itself. The class check needs one copy of @lezer/markdown,
  // the one lang-markdown uses (package.json pins the same version; a test checks it).
  wrap: (inner: PartialParse, input, _fragments, ranges) => {
    if (inner instanceof BlockContext && ranges.length === 1 && ranges[0]?.from === 0)
      inputs.set(inner, input)
    return inner
  },
}

/**
 * Highlight tags of Markdown's own marks that the editor styles apart: a
 * heading's `#`s, list markers, quote markers and task boxes. The other
 * marks (emphasis, code and link marks) keep Markdown's `processingInstruction`.
 */
export const markupTags = {
  heading: Tag.define(tags.processingInstruction),
  list: Tag.define(tags.processingInstruction),
  quote: Tag.define(tags.processingInstruction),
  task: Tag.define(tags.processingInstruction),
}

export const MarkupMarks: MarkdownConfig = {
  props: [
    styleTags({
      HeaderMark: markupTags.heading,
      ListMark: markupTags.list,
      QuoteMark: markupTags.quote,
      TaskMarker: markupTags.task,
    }),
  ],
}

export const noteParser = (markdownLanguage.parser as MarkdownParser).configure([
  FrontMatter,
  MarkupMarks,
])

function startsWithFence(input: Input): boolean {
  if (input.read(0, Math.min(input.length, 3)) !== '---') return false
  const head = input.read(0, Math.min(input.length, READ_CHUNK))
  const nl = head.indexOf('\n')
  // A first line longer than the chunk counts when it is a fence so far.
  return FENCE.test(nl < 0 ? head : head.slice(0, nl))
}

/**
 * Whether an edit may have made a fence: a line that touches a gap between
 * the fragments (where the text changed, or was not parsed) is one.
 */
function fenceInGaps(input: Input, fragments: readonly TreeFragment[]): boolean {
  for (const [i, fragment] of fragments.entries()) {
    const to = fragments[i + 1]?.from ?? input.length
    if (fenceLine(input, lineStartAt(input, fragment.to), to)) return true
  }
  return false
}

/**
 * Parses as `inner` does, except that a note starting with a fence that the
 * old tree did not read as front matter (none of its lines closed it) is
 * parsed again from its start when an edit may have added the closing fence
 * far below: the parser would otherwise reuse the old first block (a
 * thematic break) as it was. Front matter the old tree has is reused only up
 * to an edit, as any block is.
 */
class FrontMatterParser extends Parser {
  constructor(private readonly inner: Parser) {
    super()
  }

  createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly { from: number; to: number }[],
  ): PartialParse {
    const head = fragments[0]
    const stale =
      head !== undefined &&
      head.from === 0 &&
      head.tree.topNode.firstChild?.name !== FRONT_MATTER &&
      startsWithFence(input) &&
      fenceInGaps(input, fragments)
    return this.inner.createParse(input, stale ? fragments.slice(1) : fragments, ranges)
  }
}

// `markdown` adds its wrappers (code in fenced blocks) after those of its
// base, so the base already reads front matter: its wrapper must come first.
// Pasting a URL as a link is the editor's own (editor/paste.ts), so a paste
// is handled once. A fenced block's language (```js) is highlighted by its
// own parser, loaded the first time a note uses it.
const support = markdown({
  base: new Language(markdownLanguage.data, noteParser, [], 'markdown'),
  codeLanguages: languages,
  pasteURLAsLink: false,
})

/**
 * The editor's Markdown language: GFM with front matter. Return leaves a
 * list or a quote with a blank line (enter.ts) before the language's own.
 */
export const noteMarkdown = new LanguageSupport(
  new Language(
    support.language.data,
    new FrontMatterParser(support.language.parser),
    [],
    'markdown',
  ),
  [leaveMarkupKeys, support.support],
)

const token = (name: string) => `var(--color-${name})`

/**
 * The editor's highlight style, built from the design tokens so it follows the appearance (CodeMirror's
 * default has light-only colours and underlines headings). Links and their addresses are the only underlined
 * text; list markers and quotes have colours of their own (lineStyles.ts colours the second list level apart).
 */
export const noteHighlightStyle = HighlightStyle.define([
  { tag: tags.meta, color: token('syntax-comment'), fontStyle: 'italic' },
  { tag: tags.link, color: token('syntax-link'), textDecoration: 'underline' },
  { tag: tags.heading, fontWeight: 'bold', color: token('syntax-heading') },
  { tag: markupTags.heading, color: token('syntax-markup') },
  { tag: markupTags.list, color: token('syntax-list') },
  { tag: markupTags.quote, color: token('syntax-markup') },
  { tag: markupTags.task, color: token('syntax-markup'), fontWeight: 'bold' },
  { tag: tags.quote, color: token('syntax-quote'), fontStyle: 'italic' },
  { tag: tags.processingInstruction, color: token('syntax-markup') },
  { tag: [tags.tagName, tags.angleBracket, tags.attributeName], color: token('syntax-markup') },
  { tag: tags.monospace, color: token('text-editor') },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.url, color: token('syntax-link'), textDecoration: 'underline' },
  { tag: tags.labelName, color: token('syntax-link') },
  { tag: [tags.number, tags.punctuation, tags.bracket], color: token('syntax-markup') },
  { tag: tags.function(tags.variableName), color: token('syntax-function') },
  { tag: tags.contentSeparator, color: token('syntax-markup') },
  { tag: [tags.keyword, tags.operator, tags.atom, tags.bool], color: token('syntax-keyword') },
  {
    tag: [tags.string, tags.regexp, tags.escape, tags.special(tags.string)],
    color: token('syntax-string'),
  },
  { tag: [tags.literal, tags.inserted], color: token('syntax-inserted') },
  { tag: tags.deleted, color: token('syntax-deleted') },
  {
    tag: [tags.typeName, tags.namespace, tags.className, tags.macroName],
    color: token('syntax-class'),
  },
  {
    tag: [
      tags.definition(tags.variableName),
      tags.definition(tags.propertyName),
      tags.local(tags.variableName),
      tags.special(tags.variableName),
    ],
    color: token('syntax-function'),
  },
  { tag: tags.comment, color: token('syntax-comment'), fontStyle: 'italic' },
  {
    tag: tags.invalid,
    color: token('syntax-invalid'),
    textDecoration: 'underline dotted',
  },
  { tag: frontMatterTags.content, color: token('text-secondary') },
  { tag: frontMatterTags.mark, color: token('text-tertiary') },
])

/**
 * Whether the front matter of `doc`, or what could become front matter, may
 * reach the line at `pos`: the note starts with a fence and no line before
 * that one closes it. Markdown read from there must be read from the start.
 */
export function mayBeFrontMatter(doc: Text, pos: number): boolean {
  if (!FENCE.test(doc.line(1).text)) return false
  const last = doc.lineAt(pos).number
  for (let n = 2; n < last; n++) if (FENCE.test(doc.line(n).text)) return false
  return true
}
