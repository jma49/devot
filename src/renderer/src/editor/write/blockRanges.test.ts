import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { noteMarkdown } from '../markdown'
import {
  blockBackspace,
  blockDelete,
  blockEnter,
  blockLook,
  stepOverBlocks,
  writeBlocksOf,
  type WriteBlock,
} from './blockRanges'
import { setWriteFocus, writeFocusTracking } from './focus'

const FILE = 'devot://file/0190a5b2-3c4d-7e8f-9a0b-1c2d3e4f5a6b'
const IMAGE = `![Plan w:50%](${FILE})`
const WEB = '![Map](https://example.com/map.png)'

function stateOf(
  doc: string,
  selection: EditorSelection | number = 0,
  focused = true,
): EditorState {
  const state = EditorState.create({
    doc,
    selection: typeof selection === 'number' ? { anchor: selection } : selection,
    extensions: [noteMarkdown, writeFocusTracking, EditorState.allowMultipleSelections.of(true)],
  })
  ensureSyntaxTree(state, doc.length, 1e9)
  return state.update({ effects: setWriteFocus.of(focused) }).state
}

const kinds = (doc: string) =>
  writeBlocksOf(stateOf(doc)).map((b) => `${b.kind} ${doc.slice(b.from, b.to)}`)

function only(state: EditorState): WriteBlock {
  const blocks = writeBlocksOf(state)
  expect(blocks).toHaveLength(1)
  return blocks[0]!
}

function apply(state: EditorState, spec: TransactionSpec | null): EditorState {
  expect(spec).not.toBeNull()
  return state.update(spec!).state
}

const caret = (state: EditorState) => {
  const { anchor, head } = state.selection.main
  return anchor === head ? head : [anchor, head]
}

describe('which lines Write mode renders as blocks', () => {
  it('takes a line of images alone, attachments and https ones', () => {
    expect(kinds(`Intro\n\n${IMAGE}\n\n${WEB}  ${IMAGE}\n\nEnd`)).toEqual([
      `image ${IMAGE}`,
      `image ${WEB}  ${IMAGE}`,
    ])
  })

  it('leaves an image in text, an http image and one in a list or quote as source', () => {
    expect(kinds(`See ${IMAGE} here`)).toEqual([])
    expect(kinds('![x](http://example.com/a.png)')).toEqual([])
    expect(kinds(`- ${IMAGE}`)).toEqual([])
    expect(kinds(`> ${IMAGE}`)).toEqual([])
  })

  it('takes each image line of a paragraph on its own', () => {
    expect(kinds(`${IMAGE}\n${WEB}`)).toEqual([`image ${IMAGE}`, `image ${WEB}`])
  })

  it('takes $$ math over lines, on one line and in a math fence', () => {
    expect(kinds('A\n\n$$\nx^2\n\ny\n$$\n\nB')).toEqual(['math $$\nx^2\n\ny\n$$'])
    expect(kinds('$$ e = mc^2 $$')).toEqual(['math $$ e = mc^2 $$'])
    expect(kinds('```math\n\\frac12\n```')).toEqual(['math ```math\n\\frac12\n```'])
  })

  it('leaves math that is not closed, or empty, as source', () => {
    expect(kinds('$$\nx^2')).toEqual([])
    expect(kinds('$$ $$')).toEqual([])
    expect(kinds('Text $$x$$ more')).toEqual([])
  })

  it('takes a closed Mermaid fence, not an open one or other code', () => {
    expect(kinds('```mermaid\ngraph TD\nA-->B\n```\n')).toEqual([
      'diagram ```mermaid\ngraph TD\nA-->B\n```',
    ])
    expect(kinds('```mermaid\ngraph TD')).toEqual([])
    expect(kinds('```ts\nlet a = 1\n```')).toEqual([])
  })

  it('takes a video link alone on its line and a frame', () => {
    expect(kinds('https://youtu.be/dQw4w9WgXcQ')).toEqual(['embed https://youtu.be/dQw4w9WgXcQ'])
    expect(kinds('<https://vimeo.com/12345>')).toEqual(['embed <https://vimeo.com/12345>'])
    expect(kinds('https://example.com/page')).toEqual([])
    const frame = '<iframe src="https://example.com/x"></iframe>'
    expect(kinds(frame)).toEqual([`embed ${frame}`])
  })

  it('puts a click inside the source', () => {
    const doc = `${IMAGE}\n\n$$\nx^2\n$$\n\n\`\`\`mermaid\ngraph TD\n\`\`\``
    const [image, math, diagram] = writeBlocksOf(stateOf(doc))
    expect(doc.slice(image!.from, image!.entry)).toBe('![Plan w:50%')
    expect(doc.slice(math!.from, math!.entry)).toBe('$$\nx^2')
    expect(doc.slice(diagram!.from, diagram!.entry)).toBe('```mermaid\ngraph TD')
  })
})

describe('when a block shows its source', () => {
  const doc = `Top\n${IMAGE}\nEnd`
  const block = () => only(stateOf(doc))

  it('opens for a caret inside it while the editor has the keyboard', () => {
    const at = block().from + 3
    expect(blockLook(stateOf(doc, at), block())).toBe('open')
    expect(blockLook(stateOf(doc, at, false), block())).toBe('closed')
  })

  it('stays closed with the caret at its edges', () => {
    expect(blockLook(stateOf(doc, block().from), block())).toBe('closed')
    expect(blockLook(stateOf(doc, block().to), block())).toBe('closed')
  })

  it('is selected under a selection over all of it, and opens for one ending inside it', () => {
    const { from, to } = block()
    expect(blockLook(stateOf(doc, EditorSelection.single(from, to)), block())).toBe('selected')
    expect(blockLook(stateOf(doc, EditorSelection.single(0, doc.length), false), block())).toBe(
      'selected',
    )
    expect(blockLook(stateOf(doc, EditorSelection.single(0, from + 2)), block())).toBe('open')
  })
})

describe('the caret and a closed block', () => {
  const doc = `Top\n${IMAGE}\nEnd`
  const state = stateOf(doc)
  const { from, to } = only(state)

  it('Backspace after it selects it, then deletes it with its line', () => {
    const selected = apply(stateOf(doc, to), blockBackspace(stateOf(doc, to)))
    expect(caret(selected)).toEqual([from, to])
    const gone = apply(selected, blockBackspace(selected))
    expect(gone.doc.toString()).toBe('Top\nEnd')
    expect(caret(gone)).toBe(from)
  })

  it('Backspace at the start of the text line under it selects it', () => {
    const at = stateOf(doc, to + 1)
    expect(caret(apply(at, blockBackspace(at)))).toEqual([from, to])
  })

  it('Backspace on an empty line under it deletes the line as usual', () => {
    const empty = `${IMAGE}\n\nEnd`
    const block = only(stateOf(empty))
    expect(blockBackspace(stateOf(empty, block.to + 1))).toBeNull()
  })

  it('deleting the last block of a note takes the line break before it', () => {
    const last = `Top\n${IMAGE}`
    const block = only(stateOf(last))
    const selected = stateOf(last, EditorSelection.single(block.to, block.from))
    expect(apply(selected, blockBackspace(selected)).doc.toString()).toBe('Top')
  })

  it('Delete before it, or at the end of the text line over it, selects it', () => {
    const before = stateOf(doc, from)
    expect(caret(apply(before, blockDelete(before)))).toEqual([from, to])
    const over = stateOf(doc, from - 1)
    expect(caret(apply(over, blockDelete(over)))).toEqual([from, to])
    expect(blockDelete(stateOf(doc, 1))).toBeNull()
  })

  it('Return before it or after it makes a line there, and the caret goes to it', () => {
    const above = apply(stateOf(doc, from), blockEnter(stateOf(doc, from)))
    expect(above.doc.toString()).toBe(`Top\n\n${IMAGE}\nEnd`)
    expect(caret(above)).toBe(from)
    const below = apply(stateOf(doc, to), blockEnter(stateOf(doc, to)))
    expect(below.doc.toString()).toBe(`Top\n${IMAGE}\n\nEnd`)
    expect(caret(below)).toBe(to + 1)
    const selected = stateOf(doc, EditorSelection.single(from, to))
    const after = apply(selected, blockEnter(selected))
    expect(after.doc.toString()).toBe(`Top\n${IMAGE}\n\nEnd`)
    expect(caret(after)).toBe(to + 1)
  })

  it('leaves keys alone inside an open block and with several carets', () => {
    expect(blockBackspace(stateOf(doc, from + 3))).toBeNull()
    expect(blockEnter(stateOf(doc, from + 3))).toBeNull()
    const two = stateOf(
      doc,
      EditorSelection.create([EditorSelection.cursor(to), EditorSelection.cursor(1)]),
    )
    expect(blockBackspace(two)).toBeNull()
  })

  it('arrows step over it to the line past it, at the same column', () => {
    const down = stateOf(doc, 2)
    expect(stepOverBlocks(down, down.selection.main, from + 2, true)).toBe(to + 1 + 2)
    const up = stateOf(doc, to + 3)
    expect(stepOverBlocks(up, up.selection.main, to, false)).toBe(2)
    const edge = stateOf(doc, from)
    expect(stepOverBlocks(edge, edge.selection.main, to, true)).toBe(to + 1)
  })

  it('arrows stop at its edge where the note ends or starts with it', () => {
    const last = `Top\n${IMAGE}`
    const block = only(stateOf(last))
    const down = stateOf(last, 1)
    expect(stepOverBlocks(down, down.selection.main, block.from + 1, true)).toBe(block.to)
    const first = `${IMAGE}\nEnd`
    const top = only(stateOf(first))
    const up = stateOf(first, top.to + 2)
    expect(stepOverBlocks(up, up.selection.main, top.to, false)).toBe(0)
  })

  it('arrows move as usual where no block is in the way', () => {
    const plain = stateOf('a\nb\nc', 0)
    expect(stepOverBlocks(plain, plain.selection.main, 2, true)).toBe(2)
  })
})
