// Where a note can be cut into pieces that parse on their own exactly as they
// do in the whole note, so the preview re-renders only the pieces that change.
// A cut is made only at a blank line followed by a line that can only start a
// new top-level block; when in doubt the piece grows. Definitions reach across
// pieces: see definitions.ts.

export interface Block {
  text: string
  /** Where `text` starts in the note: offset and 1-based line. */
  offset: number
  line: number
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const MATH = /^ {0,3}(\${2,})(.*)$/
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const BLANK = /^[ \t]*$/
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/g
const CODE_SPAN = /(`+)[^`]*?\1/g
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])
/** Raw HTML whose end may come after a blank line. */
const SPANS: readonly [string, string][] = [
  ['<!--', '-->'],
  ['<?', '?>'],
  ['<![CDATA[', ']]>'],
]

/** Open HTML elements a line leaves, after `depth` before it; its comment, if one stays open, comes back as its end marker. */
function htmlAfter(line: string, depth: number): { depth: number; until: string | null } {
  let text = line.replace(CODE_SPAN, '')
  for (const [open, close] of SPANS) {
    let at = text.indexOf(open)
    while (at >= 0) {
      const end = text.indexOf(close, at + open.length)
      if (end < 0) return { depth: Math.max(0, depth + tagsIn(text.slice(0, at))), until: close }
      text = text.slice(0, at) + text.slice(end + close.length)
      at = text.indexOf(open, at)
    }
  }
  return { depth: Math.max(0, depth + tagsIn(text)), until: null }
}

function tagsIn(text: string): number {
  let change = 0
  // Search forward only for the next `>`: a rescan per unclosed tag is quadratic on a long line.
  let close = -1
  let noCloseFrom = -1
  for (const match of text.matchAll(TAG)) {
    if (match.index > 0 && text[match.index - 1] === '\\') continue
    const name = match[2]!.toLowerCase()
    if (match[1]) {
      change -= 1
      continue
    }
    if (VOID.has(name)) continue
    if (close < match.index && (noCloseFrom < 0 || match.index < noCloseFrom)) {
      close = text.indexOf('>', match.index)
      if (close < 0) noCloseFrom = match.index
    }
    if (close > match.index && text[close - 1] === '/') continue
    change += 1
  }
  return change
}

/**
 * Cuts `markdown` from `from`, a block start on line `line`. At each cut, `stop` may end the
 * scan: it gets the cut's offset and line, and returns whether the rest is known.
 */
function scan(
  markdown: string,
  minLength: number,
  from: number,
  line: number,
  stop: (offset: number, line: number) => boolean,
): { blocks: Block[]; stopped: boolean } {
  const blocks: Block[] = []
  let start = from
  let startLine = line
  let fence: { char: string; size: number } | null = null
  let math = 0
  let frontmatter = false
  let until: string | null = null
  let depth = 0
  let afterBlank = false

  for (let at = from; at <= markdown.length; line += 1) {
    const next = markdown.indexOf('\n', at)
    const end = next < 0 ? markdown.length : next
    const text = markdown.slice(at, markdown[end - 1] === '\r' ? end - 1 : end)

    if (frontmatter) {
      if (text === '---') frontmatter = false
    } else if (fence) {
      const close = FENCE.exec(text)
      if (
        close?.[1]?.[0] === fence.char &&
        close[1].length >= fence.size &&
        BLANK.test(close[2] ?? '')
      ) {
        fence = null
      }
    } else if (math > 0) {
      const close = MATH.exec(text)
      if (close?.[1] && close[1].length >= math && BLANK.test(close[2] ?? '')) math = 0
    } else if (until !== null) {
      const closed = text.indexOf(until)
      if (closed >= 0) {
        const after = htmlAfter(text.slice(closed + until.length), depth)
        until = after.until
        depth = after.depth
      }
    } else if (BLANK.test(text)) {
      afterBlank = true
    } else {
      if (
        afterBlank &&
        at - start >= minLength &&
        depth === 0 &&
        text[0] !== ' ' &&
        text[0] !== '\t' &&
        !LIST_ITEM.test(text)
      ) {
        blocks.push({ text: markdown.slice(start, at), offset: start, line: startLine })
        if (stop(at, line)) return { blocks, stopped: true }
        start = at
        startLine = line
      }
      afterBlank = false
      const open = FENCE.exec(text)
      const opensMath = MATH.exec(text)
      if (at === 0 && text === '---') frontmatter = true
      else if (open?.[1] && !(open[1][0] === '`' && open[2]?.includes('`'))) {
        fence = { char: open[1][0]!, size: open[1].length }
      } else if (opensMath?.[1] && !opensMath[2]?.includes('$')) {
        math = opensMath[1].length
      } else {
        const after = htmlAfter(text, depth)
        until = after.until
        depth = after.depth
      }
    }
    if (next < 0) break
    at = next + 1
  }
  blocks.push({ text: markdown.slice(start), offset: start, line: startLine })
  return { blocks, stopped: false }
}

/** Pieces are at least `minLength` long (bar the last): each piece costs some setting up. */
export function splitBlocks(markdown: string, minLength = 1): Block[] {
  return scan(markdown, minLength, 0, 1, () => false).blocks
}

export interface NoteSplit {
  blocks: Block[]
  /** For each block, the index of the block with its text in the split before, or -1. */
  was: number[]
}

// Comparing a slice compares memory; `startsWith` reads a character at a time, about 7 times slower in V8.
const textAt = (markdown: string, text: string, at: number) =>
  markdown.slice(at, at + text.length) === text

/**
 * `splitBlocks` for a note that changes a little at a time: each split cuts again only from the
 * block before the first that changed, until a cut meets a block whose text runs unchanged to the
 * end. Every cut starts a scan afresh, so the blocks after it are the ones the split before had.
 */
export function createBlockSplitter(minLength = 1): (markdown: string) => NoteSplit {
  let last: { markdown: string; split: NoteSplit } | undefined

  const splitAfresh = (markdown: string): NoteSplit => {
    const blocks = splitBlocks(markdown, minLength)
    return { blocks, was: blocks.map(() => -1) }
  }

  const splitAgain = (markdown: string, before: string, old: readonly Block[]): NoteSplit => {
    let changed = 0
    while (changed < old.length - 1 && textAt(markdown, old[changed]!.text, old[changed]!.offset))
      changed += 1
    const from = Math.max(0, changed - 1)
    const delta = markdown.length - before.length
    // The first of the old blocks whose text, moved by `delta`, runs unchanged to the end.
    let same = old.length
    while (
      same > from + 1 &&
      old[same - 1]!.offset + delta > old[from]!.offset &&
      textAt(markdown, old[same - 1]!.text, old[same - 1]!.offset + delta)
    )
      same -= 1
    const resumes = new Map<number, number>()
    for (let i = same; i < old.length; i += 1) resumes.set(old[i]!.offset + delta, i)
    let resumed = -1
    let lines = 0
    const { blocks: middle } = scan(
      markdown,
      minLength,
      old[from]!.offset,
      old[from]!.line,
      (offset, line) => {
        const at = resumes.get(offset)
        if (at === undefined) return false
        resumed = at
        lines = line - old[at]!.line
        return true
      },
    )
    const blocks: Block[] = []
    const was: number[] = []
    for (let i = 0; i < from; i += 1) {
      const { offset, line, text } = old[i]!
      blocks.push({ text: markdown.slice(offset, offset + text.length), offset, line })
      was.push(i)
    }
    for (const block of middle) {
      blocks.push(block)
      const unchanged =
        block.offset === old[from]!.offset && block.text.length === old[from]!.text.length
      was.push(unchanged && from < changed ? from : -1)
    }
    if (resumed >= 0) {
      for (let i = resumed; i < old.length; i += 1) {
        const { text, offset, line } = old[i]!
        const at = offset + delta
        blocks.push({ text: markdown.slice(at, at + text.length), offset: at, line: line + lines })
        was.push(i)
      }
    }
    return { blocks, was }
  }

  return (markdown) => {
    const split =
      last?.markdown === markdown
        ? { blocks: last.split.blocks, was: last.split.blocks.map((_, i) => i) }
        : last
          ? splitAgain(markdown, last.markdown, last.split.blocks)
          : splitAfresh(markdown)
    last = { markdown, split }
    return split
  }
}

/**
 * One splitter for several readers of the same texts: each text is cut once, and each reader's
 * `was` names the blocks of the split that reader read before (none when it missed a text).
 */
export function shareSplitter(
  split: (markdown: string) => NoteSplit,
): () => (markdown: string) => NoteSplit {
  // Splits are told apart by count, so the one before is not kept with its note's text.
  let last: (NoteSplit & { markdown: string; count: number }) | undefined
  return () => {
    let read = 0
    return (markdown) => {
      if (last?.markdown !== markdown) {
        last = { ...split(markdown), markdown, count: (last?.count ?? 0) + 1 }
      }
      const { blocks, count } = last
      const was =
        read === count - 1 ? last.was : blocks.map(read === count ? (_, i) => i : () => -1)
      read = count
      return { blocks, was }
    }
  }
}
