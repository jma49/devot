import type { Blockquote, Nodes } from 'mdast'
import { parseMarkdown } from './frontMatter'
import { replaceRanges, type TextEdit } from './text'

type AlertKind = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION'

const KINDS: Record<string, AlertKind> = {}
const group = (kind: AlertKind, names: string[]) => names.forEach((name) => (KINDS[name] = kind))
group('NOTE', ['note', 'info', 'abstract', 'summary', 'tldr', 'todo', 'example', 'quote', 'cite'])
group('TIP', ['tip', 'hint', 'success', 'check', 'done'])
group('IMPORTANT', ['important', 'question', 'help', 'faq'])
group('WARNING', ['warning', 'caution', 'attention'])
group('CAUTION', ['danger', 'error', 'bug', 'failure', 'fail', 'missing'])

const HEADER = /^((?:[ \t]{0,3}>[ \t]?)+)\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*(.*?)[ \t]*(\r?)$/

/**
 * A block quote that opens with `[!kind]`, an optional fold marker and an optional title becomes
 * the alert of the nearest kind, the title a bold line under its header.
 */
export function calloutsAsAlerts(markdown: string): string {
  const starts = new Set<number>()
  const walk = (node: Nodes) => {
    if (node.type === 'blockquote') {
      const offset = lineStart(markdown, (node as Blockquote).position?.start.offset)
      if (offset !== null) starts.add(offset)
    }
    if ('children' in node) for (const child of node.children) walk(child as Nodes)
  }
  walk(parseMarkdown(markdown))
  const edits: TextEdit[] = []
  for (const start of starts) {
    const end = markdown.indexOf('\n', start)
    const line = markdown.slice(start, end < 0 ? undefined : end)
    const match = HEADER.exec(line)
    if (!match) continue
    const [, prefix, name, , title, cr] = match as unknown as string[]
    const kind = KINDS[name!.toLowerCase()] ?? 'NOTE'
    const header = `${prefix}[!${kind}]`
    const text = title ? `${header}${cr}\n${prefix}**${title}**${cr}` : `${header}${cr}`
    if (text !== line) edits.push({ start, end: start + line.length, text })
  }
  return edits.length === 0
    ? markdown
    : replaceRanges(
        markdown,
        edits.sort((a, b) => a.start - b.start),
      )
}

function lineStart(markdown: string, offset: number | undefined): number | null {
  if (offset === undefined) return null
  return markdown.lastIndexOf('\n', offset - 1) + 1
}
