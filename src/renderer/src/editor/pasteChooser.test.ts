import { history, redo, undo } from '@codemirror/commands'
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state'
import { describe, expect, it, vi } from 'vitest'
import { noteMarkdown } from './markdown'
import { pasteTransaction, pasteUrlAs } from './paste'
import {
  chooserOf,
  fetchFor,
  pasteChooser,
  pickFormat,
  type ChooserTarget,
  type PasteFetcher,
} from './pasteChooser'

// `|` marks a cursor.
function editor(marked: string, fetcher: PasteFetcher | null = null) {
  const ranges = []
  let doc = ''
  for (const ch of marked) {
    if (ch === '|') ranges.push(EditorSelection.cursor(doc.length))
    else doc += ch
  }
  let state = EditorState.create({
    doc,
    selection: EditorSelection.create(ranges.length ? ranges : [EditorSelection.cursor(0)]),
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      noteMarkdown,
      history(),
      pasteChooser(fetcher),
    ],
  })
  const target: ChooserTarget & { show(): string; paste(text: string): boolean } = {
    get state() {
      return state
    },
    dispatch(tr: Transaction) {
      state = tr.state
    },
    show() {
      const { from, to } = state.selection.main
      const text = state.doc.toString()
      return from === to
        ? `${text.slice(0, from)}|${text.slice(from)}`
        : `${text.slice(0, from)}«${text.slice(from, to)}»${text.slice(to)}`
    },
    paste(text: string) {
      const spec = pasteTransaction(state, text, 'choose')
      if (spec) state = state.update(spec).state
      return spec !== null
    },
  }
  return target
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const URL = 'https://example.com/a'

describe('the paste chooser', () => {
  it('opens on a lone URL pasted as copied, without fetching anything', () => {
    const fetcher = {
      title: vi.fn<PasteFetcher['title']>(),
      snippet: vi.fn<PasteFetcher['snippet']>(),
    }
    const ed = editor('See |', fetcher)
    expect(ed.paste(URL)).toBe(true)
    expect(ed.show()).toBe(`See ${URL}|`)
    const c = chooserOf(ed.state)
    expect(c).toMatchObject({ from: 4, to: 4 + URL.length, url: URL, picked: null })
    expect(c?.formats.map((f) => f.type)).toEqual(['plain', 'title', 'emptyText', 'autolink'])
    expect(fetcher.title).not.toHaveBeenCalled()
    expect(fetcher.snippet).not.toHaveBeenCalled()
  })

  it('leaves multiple cursors and literal text to the usual paste', () => {
    expect(editor('a| b|').paste(URL)).toBe(false)
    expect(editor('```\n|\n```').paste(URL)).toBe(false)
    expect(editor('a `co|de` b').paste(URL)).toBe(false)
    expect(editor('---\ntitle: |\n---\n').paste(URL)).toBe(false)
  })

  it('swaps the URL for the picked format, as one undo step with the paste', () => {
    const ed = editor('Go !|')
    ed.paste(URL)
    pickFormat(ed, 'emptyText')
    // The `!` is escaped so the link is no image; the caret waits in the text.
    expect(ed.show()).toBe(`Go \\![|](${URL})`)
    expect(chooserOf(ed.state)).toBeNull()
    undo(ed)
    expect(ed.show()).toBe('Go !|')
    redo(ed)
    expect(ed.state.doc.toString()).toBe(`Go \\![](${URL})`)
  })

  it('writes an autolink, or keeps the plain URL', () => {
    const auto = editor('|')
    auto.paste(URL)
    pickFormat(auto, 'autolink')
    expect(auto.show()).toBe(`<${URL}>|`)

    const plain = editor('|')
    plain.paste(URL)
    pickFormat(plain, 'plain')
    expect(plain.show()).toBe(`${URL}|`)
    expect(chooserOf(plain.state)).toBeNull()
  })

  it('closes on a caret move, an edit over the URL, undo, or redo', () => {
    const moved = editor('|')
    moved.paste(URL)
    moved.dispatch(moved.state.update({ selection: EditorSelection.cursor(2) }))
    expect(chooserOf(moved.state)).toBeNull()

    const edited = editor('|')
    edited.paste(URL)
    edited.dispatch(edited.state.update({ changes: { from: 0, to: 5 } }))
    expect(chooserOf(edited.state)).toBeNull()

    const undone = editor('|')
    undone.paste(URL)
    undo(undone)
    expect(chooserOf(undone.state)).toBeNull()
    expect(undone.show()).toBe('|')
  })

  it('follows an edit elsewhere, and the pick is then a step of its own', () => {
    const ed = editor('a\n|')
    ed.paste(URL)
    ed.dispatch(ed.state.update({ changes: { from: 0, insert: 'xy' } }))
    expect(chooserOf(ed.state)).toMatchObject({ from: 4, to: 4 + URL.length })
    pickFormat(ed, 'autolink')
    expect(ed.state.doc.toString()).toBe(`xya\n<${URL}>`)
    undo(ed)
    expect(ed.state.doc.toString()).toBe(`xya\n${URL}`)
  })

  it('fetches the title once picked, then links it with the title selected', async () => {
    const fetcher = {
      title: vi.fn<PasteFetcher['title']>(async () => 'A [b]'),
      snippet: vi.fn<PasteFetcher['snippet']>(),
    }
    const ed = editor('|', fetcher)
    ed.paste(URL)
    pickFormat(ed, 'title')
    expect(fetcher.title).toHaveBeenCalledWith(URL)
    expect(chooserOf(ed.state)?.fetches.get('title')).toEqual({ status: 'loading' })
    await settle()
    expect(ed.show()).toBe(`[«A \\[b\\]»](${URL})`)
    undo(ed)
    expect(ed.show()).toBe('|')
  })

  it('fetches while a format is highlighted, once, and picks from what came back', async () => {
    const fetcher = {
      title: vi.fn<PasteFetcher['title']>(async () => 'Page'),
      snippet: vi.fn<PasteFetcher['snippet']>(),
    }
    const ed = editor('|', fetcher)
    ed.paste(URL)
    fetchFor(ed, 'emptyText')
    expect(fetcher.title).not.toHaveBeenCalled()
    fetchFor(ed, 'title')
    fetchFor(ed, 'title')
    expect(fetcher.title).toHaveBeenCalledTimes(1)
    await settle()
    expect(chooserOf(ed.state)?.fetches.get('title')).toEqual({ status: 'done', text: 'Page' })
    // Still open: highlighting is no pick.
    expect(ed.state.doc.toString()).toBe(URL)
    pickFormat(ed, 'title')
    expect(ed.state.doc.toString()).toBe(`[Page](${URL})`)
  })

  it('shows why a fetch failed, and a pick then keeps the URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetcher = {
      title: vi.fn<PasteFetcher['title']>(async () => {
        throw 'E_LINK_NOT_HTML'
      }),
      snippet: vi.fn<PasteFetcher['snippet']>(),
    }
    const ed = editor('|', fetcher)
    ed.paste(URL)
    fetchFor(ed, 'title')
    await settle()
    expect(chooserOf(ed.state)?.fetches.get('title')).toEqual({
      status: 'error',
      message: 'pasteFormat.notHtml',
    })
    expect(warn).toHaveBeenCalledWith('W_PASTE_FETCH_FAILED', 'E_LINK_NOT_HTML')
    pickFormat(ed, 'title')
    expect(ed.show()).toBe(`${URL}|`)
    expect(chooserOf(ed.state)).toBeNull()
    warn.mockRestore()
  })

  it('reads a page without a title as an error', async () => {
    const ed = editor('|', { title: async () => null, snippet: vi.fn<PasteFetcher['snippet']>() })
    ed.paste(URL)
    pickFormat(ed, 'title')
    await settle()
    expect(ed.show()).toBe(`${URL}|`)
  })

  it('drops a fetch that ends after the chooser closed', async () => {
    let finish: (title: string) => void = () => {}
    const title = () => new Promise<string>((resolve) => (finish = resolve))
    const ed = editor('|', { title, snippet: vi.fn<PasteFetcher['snippet']>() })
    ed.paste(URL)
    pickFormat(ed, 'title')
    ed.dispatch(ed.state.update({ selection: EditorSelection.cursor(0) }))
    finish('Late')
    await settle()
    expect(ed.state.doc.toString()).toBe(URL)
  })

  it('pastes a GitHub file as a fenced snippet on a line of its own', async () => {
    const link = 'https://github.com/o/r/blob/main/a.ts#L2'
    const ed = editor('Code: |', {
      title: vi.fn<PasteFetcher['title']>(),
      snippet: async () => 'one\ntwo\n',
    })
    ed.paste(link)
    expect(chooserOf(ed.state)?.formats[1]?.type).toBe('snippet')
    pickFormat(ed, 'snippet')
    await settle()
    expect(ed.show()).toBe(`Code: \n\`\`\`ts line=2 branch=main url=${link}\ntwo\n\`\`\`|`)
    undo(ed)
    expect(ed.show()).toBe('Code: |')
  })
})

describe('the snippet format', () => {
  const link = 'https://github.com/o/r/blob/main/a.ts#L2'

  it('is offered only where a block can go', () => {
    for (const marked of ['> quote |', '- item |', '| a | b |\n| - | - |\n| x | |y |']) {
      const ed = editor(marked)
      ed.paste(link)
      expect(chooserOf(ed.state)?.formats.map((f) => f.type) ?? []).not.toContain('snippet')
    }
    const top = editor('|')
    top.paste(link)
    expect(chooserOf(top.state)?.formats.map((f) => f.type)).toContain('snippet')
  })

  it('reads lines the file lacks as an error, keeping the URL', async () => {
    const ed = editor('|', { title: vi.fn<PasteFetcher['title']>(), snippet: async () => 'one' })
    ed.paste(link.replace('#L2', '#L9'))
    fetchFor(ed, 'snippet')
    await settle()
    expect(chooserOf(ed.state)?.fetches.get('snippet')).toEqual({
      status: 'error',
      message: 'pasteFormat.noLines',
    })
  })
})

describe('Paste URL As', () => {
  it('pastes the clipboard URL with the chooser open', () => {
    const ed = editor('x |')
    const spec = pasteUrlAs(ed.state, `  ${URL}\n`)
    expect(spec).not.toBeNull()
    ed.dispatch(ed.state.update(spec!))
    expect(ed.show()).toBe(`x ${URL}|`)
    expect(chooserOf(ed.state)?.url).toBe(URL)
  })

  it('opens the chooser on the link at the caret when the clipboard has no URL', () => {
    const ed = editor(`See [te|xt](${URL}) now`)
    const spec = pasteUrlAs(ed.state, 'not a url')
    expect(spec).not.toBeNull()
    ed.dispatch(ed.state.update(spec!))
    const end = `See [text](${URL})`.length
    expect(chooserOf(ed.state)).toMatchObject({ from: 4, to: end, url: URL, pasted: false })
    pickFormat(ed, 'autolink')
    expect(ed.show()).toBe(`See <${URL}>| now`)

    const bare = editor(`<${URL}|>`)
    bare.dispatch(bare.state.update(pasteUrlAs(bare.state, '')!))
    pickFormat(bare, 'plain')
    expect(bare.show()).toBe(`${URL}|`)
  })

  it('does nothing without a URL on the clipboard or at the caret', () => {
    expect(pasteUrlAs(editor('plain |text').state, 'words')).toBeNull()
    // An image's address, or a reference definition's, is no link to reformat.
    expect(pasteUrlAs(editor(`![alt](${URL}|)`).state, '')).toBeNull()
    expect(pasteUrlAs(editor(`[ref]: ${URL}|`).state, '')).toBeNull()
  })
})
