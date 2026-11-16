// A drawn block edited in its plugin (ADR 0029) goes back into the note in place of the block's content, in the block's
// own fence, inside the same list item or quote.

const OPENING = /^(`{3,}|~{3,})(.*)$/
const CLOSING = /^(.*?)(`{3,}|~{3,})[ \t]*$/

/**
 * `block` is the note's text of a fenced code block, from its opening fence to the end of its closing one. Gives it with
 * `source` as its content, or null when its content is no longer `expected` or it is no fenced block.
 */
export function editedBlock(block: string, expected: string, source: string): string | null {
  const lines = block.split('\n')
  const opening = OPENING.exec(lines[0]!)
  if (!opening) return null
  const fence = opening[1]!
  const last = lines.length > 1 ? CLOSING.exec(lines.at(-1)!) : null
  const closed =
    last !== null &&
    last[2]![0] === fence[0] &&
    last[2]!.length >= fence.length &&
    /^[\s>]*$/.test(last[1]!)
  const prefix = closed ? last[1]! : ''
  const inner = lines.slice(1, closed ? -1 : undefined)
  const content: string[] = []
  for (const line of inner) {
    if (line.startsWith(prefix)) content.push(line.slice(prefix.length))
    else if (prefix.startsWith(line) && line.trim() === prefix.trim()) content.push('')
    else return null
  }
  if (content.join('\n') !== expected) return null
  const longest = Math.max(
    0,
    ...(source.match(new RegExp(`\\${fence[0]}+`, 'g')) ?? []).map((run) => run.length),
  )
  const next = fence[0]!.repeat(Math.max(fence.length, longest + 1))
  const body = source
    .split('\n')
    .map((line) => (line === '' ? prefix.trimEnd() : prefix + line))
    .join('\n')
  return `${next}${opening[2]}\n${body}\n${prefix}${next}`
}
