import { Fragment } from 'react'
import { matchSegments } from '../../core/search'

interface Segment {
  text: string
  match: boolean
}

function marks(segments: readonly Segment[], className: string | undefined) {
  return segments.map((s, i) =>
    s.match ? (
      <mark key={i} className={className}>
        {s.text}
      </mark>
    ) : (
      <Fragment key={i}>{s.text}</Fragment>
    ),
  )
}

/** `text` with what `pattern` matches marked. */
export function Marked(props: {
  text: string
  pattern: RegExp | null | undefined
  className?: string
}) {
  if (!props.pattern) return props.text
  return marks(matchSegments(props.text, props.pattern), props.className)
}

/** `text` with the `[from, to)` ranges marked, in order and apart. */
export function MarkedRanges({
  text,
  ranges,
}: {
  text: string
  ranges: readonly [number, number][]
}) {
  const parts: Segment[] = []
  let at = 0
  for (const [from, to] of ranges) {
    if (from > at) parts.push({ text: text.slice(at, from), match: false })
    parts.push({ text: text.slice(from, to), match: true })
    at = to
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false })
  return marks(parts, undefined)
}
