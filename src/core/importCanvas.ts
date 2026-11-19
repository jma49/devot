import { linkText } from './links'

interface CanvasNode {
  id: string
  type: 'text' | 'file' | 'link' | 'group'
  x: number
  y: number
  width: number
  height: number
  text?: string
  file?: string
  url?: string
  label?: string
}

const IMAGE = /\.(?:png|jpe?g|gif|webp|avif|heic|heif)$/i
const short = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 80)

export function canvasMarkdown(raw: string): string {
  const invalid = () => new Error('E_IMPORT_CANVAS_INVALID')
  let value: { nodes?: unknown; edges?: unknown }
  try {
    value = JSON.parse(raw)
    if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw invalid()
  } catch {
    throw invalid()
  }
  const nodes = value.nodes as CanvasNode[]
  const ids = new Set<string>()
  for (const node of nodes) {
    if (
      !node ||
      typeof node.id !== 'string' ||
      ids.has(node.id) ||
      !['text', 'file', 'link', 'group'].includes(node.type) ||
      ![node.x, node.y, node.width, node.height].every(Number.isFinite) ||
      node.width < 0 ||
      node.height < 0 ||
      (node.type === 'text' && typeof node.text !== 'string') ||
      (node.type === 'file' && typeof node.file !== 'string') ||
      (node.type === 'link' && typeof node.url !== 'string') ||
      (node.label !== undefined && typeof node.label !== 'string')
    )
      throw invalid()
    ids.add(node.id)
  }
  const ordered = nodes.toSorted((a, b) => a.y - b.y || a.x - b.x)
  const groups = ordered.filter((node) => node.type === 'group')
  const parents = new Map<CanvasNode, CanvasNode>()
  for (const node of ordered) {
    const area = node.width * node.height
    const parent = groups
      .filter(
        (g) =>
          g !== node &&
          g.width * g.height > area &&
          node.x >= g.x &&
          node.y >= g.y &&
          node.x + node.width <= g.x + g.width &&
          node.y + node.height <= g.y + g.height,
      )
      .toSorted((a, b) => a.width * a.height - b.width * b.height)[0]
    if (parent) parents.set(node, parent)
  }
  const label = (node: CanvasNode) =>
    short(node.label ?? node.text ?? node.file ?? node.url ?? node.id)
  const blocks: string[] = []
  const render = (parent?: CanvasNode) => {
    for (const node of ordered.filter((n) => parents.get(n) === parent)) {
      switch (node.type) {
        case 'group':
          blocks.push(`## ${label(node)}`)
          render(node)
          break
        case 'text':
          blocks.push(node.text!)
          break
        case 'file':
          blocks.push(`${IMAGE.test(node.file!) ? '!' : ''}[[${node.file}]]`)
          break
        case 'link':
          blocks.push(
            `[${linkText(node.url!)}](<${node
              .url!.replace(/</g, '%3C')
              .replace(/>/g, '%3E')
              .replace(/[\r\n]/g, '')}>)`,
          )
          break
      }
    }
  }
  render()
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const connections: string[] = []
  for (const edge of value.edges as { fromNode?: string; toNode?: string; label?: string }[]) {
    if (
      !edge ||
      typeof edge.fromNode !== 'string' ||
      typeof edge.toNode !== 'string' ||
      (edge.label !== undefined && typeof edge.label !== 'string')
    )
      throw invalid()
    const from = byId.get(edge.fromNode)
    const to = byId.get(edge.toNode)
    if (!from || !to) throw invalid()
    connections.push(`- ${label(from)} → ${label(to)}${edge.label ? `: ${short(edge.label)}` : ''}`)
  }
  if (connections.length) blocks.push('## Connections', connections.join('\n'))
  return blocks.length ? `${blocks.join('\n\n')}\n` : ''
}
