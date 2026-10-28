import { describe, expect, it } from 'vitest'
import { DRAG_BOOK, DRAG_NOTE, noteDragHtml, setBookDragData, setNoteDragData } from './dragData'

function transfer() {
  const data = new Map<string, string>()
  const dt = {
    effectAllowed: 'uninitialized',
    setData: (type: string, value: string) => void data.set(type, value),
  }
  return { dt: dt as unknown as DataTransfer, data, effect: () => dt.effectAllowed }
}

describe('note drags', () => {
  it('carry the IDs, Markdown links and anchors, and allow copy', () => {
    const { dt, data, effect } = transfer()
    setNoteDragData(dt, [
      { id: 'a1', title: 'First' },
      { id: 'b2', title: 'Second' },
    ])
    expect(data.get(DRAG_NOTE)).toBe('a1\nb2')
    expect(data.get('text/plain')).toBe('[First](devot://note/a1)\n[Second](devot://note/b2)')
    expect(data.get('text/html')).toBe(
      '<a href="devot://note/a1">First</a><br><a href="devot://note/b2">Second</a>',
    )
    expect(data.has('text/uri-list')).toBe(false)
    expect(effect()).toBe('copyMove')
  })

  it('escape titles in the anchors and brackets in the links', () => {
    const { dt, data } = transfer()
    setNoteDragData(dt, [{ id: 'x', title: 'A <b> & "c" [d]' }])
    expect(noteDragHtml([{ id: 'x', title: 'A <b> & "c"' }])).toBe(
      '<a href="devot://note/x">A &lt;b&gt; &amp; &quot;c&quot;</a>',
    )
    expect(data.get('text/html')).toContain('A &lt;b&gt; &amp; &quot;c&quot; [d]')
    // The title's Markdown punctuation is escaped, so the link text is the title as typed.
    expect(data.get('text/plain')).toBe('[A \\<b\\> \\& "c" \\[d\\]](devot://note/x)')
  })
})

describe('notebook drags', () => {
  it('carry the ID, Name:<id> as text, and allow copy', () => {
    const { dt, data, effect } = transfer()
    setBookDragData(dt, { id: 'k9', name: 'Work' })
    expect(data.get(DRAG_BOOK)).toBe('k9')
    expect(data.get('text/plain')).toBe('Work:k9')
    expect(effect()).toBe('copyMove')
  })
})
