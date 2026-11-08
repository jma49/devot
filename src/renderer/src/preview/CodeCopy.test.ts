// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { pieceCodeBlocks } from './CodeCopy'
import type { ShownPiece } from './dom'

function piece(key: string, html: string): ShownPiece {
  const holder = document.createElement('div')
  holder.innerHTML = html
  return { key, line: 1, offset: 0, nodes: Array.from(holder.childNodes), marked: [] }
}

describe('the code blocks of the pieces shown', () => {
  it('lists the fenced blocks with text, in order, but not front matter or empty blocks', () => {
    const pieces = [
      piece('a', '<pre class="frontmatter"><code>title: A</code></pre><pre><code>one</code></pre>'),
      piece('b', '<p>prose</p><pre><code></code></pre><pre><code>\n</code></pre>'),
      piece('c', '<div class="code-block"><pre><code>two</code></pre></div>'),
    ]
    expect(pieceCodeBlocks(pieces).map((pre) => pre.textContent)).toEqual(['one', 'two'])
  })

  it('reads a piece once while it stays shown', () => {
    const kept = piece('a', '<pre><code>one</code></pre>')
    const first = pieceCodeBlocks([kept])
    kept.nodes[0]!.textContent = ''
    expect(pieceCodeBlocks([kept, piece('b', '<pre><code>two</code></pre>')])).toEqual([
      first[0],
      expect.objectContaining({ textContent: 'two' }),
    ])
  })

  it('reads a piece left waiting again once it is built', () => {
    const waiting: ShownPiece = { key: 'a', line: 1, offset: 0, nodes: [], marked: [], pending: [] }
    expect(pieceCodeBlocks([waiting])).toEqual([])
    waiting.nodes = piece('a', '<pre><code>one</code></pre>').nodes
    delete waiting.pending
    expect(pieceCodeBlocks([waiting]).map((pre) => pre.textContent)).toEqual(['one'])
  })
})
