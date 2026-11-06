import type { Nodes } from 'hast'

/** The text an HTML tree shows: its text nodes in order, without comments. */
export const textOf = (node: Nodes): string =>
  node.type === 'text' ? node.value : 'children' in node ? node.children.map(textOf).join('') : ''
