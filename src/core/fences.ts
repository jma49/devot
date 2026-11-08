/** An open code fence: its mark, how many marks open it, and how many quote markers hold it. */
export interface Fence {
  readonly mark: '`' | '~'
  readonly size: number
  readonly depth: number
}

const QUOTE_MARKER = /^ {0,3}>[ \t]?/
const OPENING = /^((?: {0,3}>[ \t]?)*) {0,3}(`{3,}|~{3,})(.*)$/s
const CLOSING = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

function withoutQuoteMarkers(line: string, depth: number): string | undefined {
  let rest = line
  for (let i = 0; i < depth; i += 1) {
    const marker = QUOTE_MARKER.exec(rest)
    if (!marker) return undefined
    rest = rest.slice(marker[0].length)
  }
  return rest
}

/**
 * Reads one line, without its line break, with `fence` open before it, the CommonMark way: a
 * backtick fence's info string holds no backtick, a closing fence nothing but spaces after its
 * marks, and a quoted fence ends with its quote. `code` says whether the line belongs to a code
 * block, its fences included.
 */
export function readFence(
  line: string,
  fence: Fence | undefined,
): { fence: Fence | undefined; code: boolean } {
  if (fence) {
    const inner = withoutQuoteMarkers(line, fence.depth)
    if (inner !== undefined) {
      const marks = CLOSING.exec(inner)?.[1]
      const closes = marks !== undefined && marks[0] === fence.mark && marks.length >= fence.size
      return { fence: closes ? undefined : fence, code: true }
    }
  }
  const open = OPENING.exec(line)
  if (!open) return { fence: undefined, code: false }
  const [, quotes = '', marks = '', info = ''] = open
  const mark = marks[0] === '~' ? '~' : '`'
  if (mark === '`' && info.includes('`')) return { fence: undefined, code: false }
  const depth = quotes.split('>').length - 1
  return { fence: { mark, size: marks.length, depth }, code: true }
}

export function sameFence(a: Fence | undefined, b: Fence | undefined): boolean {
  return a === b || (!!a && !!b && a.mark === b.mark && a.size === b.size && a.depth === b.depth)
}
