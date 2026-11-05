import type { Break, Parent, PhrasingContent, Root, Text } from 'mdast'

const BREAK: Break = { type: 'break' }

function breaksIn(parent: Parent): void {
  const next: PhrasingContent[] = []
  let changed = false
  for (const child of parent.children as PhrasingContent[]) {
    if ('children' in child) breaksIn(child as Parent)
    if (child.type !== 'text' || !child.value.includes('\n')) {
      next.push(child)
      continue
    }
    changed = true
    child.value.split('\n').forEach((line, index) => {
      if (index > 0) next.push({ ...BREAK })
      if (line) next.push({ type: 'text', value: line } satisfies Text)
    })
  }
  if (changed) parent.children = next as Parent['children']
}

/** A single newline inside a paragraph is a line break, so the preview shows the lines as typed. */
export function remarkSoftBreaks() {
  return (tree: Root) => breaksIn(tree)
}
