import { describe, expect, it } from 'vitest'
import { canvasMarkdown } from '../../src/core/importCanvas'

describe('canvas Markdown', () => {
  it('keeps text, orders nodes within groups and names connections', () => {
    const nodes = [
      { id: 'g', type: 'group', label: 'Work', x: 0, y: 0, width: 500, height: 500 },
      { id: 'b', type: 'file', file: 'Photo.png', x: 100, y: 100, width: 10, height: 10 },
      { id: 'a', type: 'text', text: '**Plan**', x: 10, y: 10, width: 10, height: 10 },
      { id: 'c', type: 'file', file: 'Note.md', x: 0, y: 600, width: 10, height: 10 },
      { id: 'd', type: 'link', url: 'https://example.com', x: 50, y: 600, width: 10, height: 10 },
    ]
    expect(
      canvasMarkdown(
        JSON.stringify({ nodes, edges: [{ fromNode: 'a', toNode: 'b', label: 'next' }] }),
      ),
    ).toBe(
      '## Work\n\n**Plan**\n\n![[Photo.png]]\n\n[[Note.md]]\n\n[https://example.com](<https://example.com>)\n\n## Connections\n\n- **Plan** → Photo.png: next\n',
    )
  })

  it('handles an empty canvas', () => {
    expect(canvasMarkdown('{"nodes":[],"edges":[]}')).toBe('')
  })

  it.each(['not json', '{}', '{"nodes":[{}],"edges":[]}'])(
    'rejects invalid data without its content',
    (raw) => {
      expect(() => canvasMarkdown(raw)).toThrow('E_IMPORT_CANVAS_INVALID')
    },
  )
})
