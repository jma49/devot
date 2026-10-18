import {
  CompletionContext,
  type Completion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { noteMarkdown } from './editor/markdown'
import { linkCompletion, type LinkSources } from './linkCompletion'

const ID = '0192a6f0-0000-7000-8000-000000000001'

/** A promise settled from outside, to edit the note while one is being made. */
function later<T>() {
  let settle!: (value: T) => void
  let fail!: (reason: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  return { promise, settle, fail }
}

function setup(doc: string, head: number) {
  const made = later<string>()
  const sources = {
    find: vi.fn<LinkSources['find']>(async () => [{ id: ID, title: 'Groceries' }]),
    create: vi.fn<LinkSources['create']>(() => made.promise),
    discard: vi.fn<LinkSources['discard']>(async () => {}),
    linked: vi.fn<LinkSources['linked']>(),
    preview: vi.fn<NonNullable<LinkSources['preview']>>(async () => null),
  } satisfies LinkSources
  let state = EditorState.create({
    doc,
    selection: { anchor: head },
    extensions: [noteMarkdown, linkCompletion(sources)],
  })
  const view = {
    get state() {
      return state
    },
    dom: { isConnected: true },
    dispatch: (spec: TransactionSpec) => {
      state = state.update(spec).state
    },
  }
  // The editor asks every completion source its language has (the Markdown
  // language has one of its own); the first with a result is the popup.
  const source = async (at = state.selection.main.head) => {
    for (const each of state.languageDataAt<CompletionSource>('autocomplete', at)) {
      const result = await each(new CompletionContext(state, at, false))
      if (result) return result
    }
    return null
  }
  const type = (at: number, text: string) => view.dispatch({ changes: { from: at, insert: text } })
  return { made, sources, view, source, type, asView: view as unknown as EditorView }
}

/** The popup's options for the cursor's place. */
async function options(source: () => Promise<CompletionResult | null>) {
  const result = await source()
  if (!result) throw new Error('no popup')
  return result.options as (Completion & { apply: (...args: unknown[]) => void })[]
}

describe('where the [[ popup opens', () => {
  it('opens in a paragraph', async () => {
    const { source } = setup('See [[gro]]', 9)
    expect(await source()).not.toBeNull()
  })

  it('does not open in a fenced code block', async () => {
    const doc = '```lua\nx = t[[]]\n```\n'
    const { source } = setup(doc, doc.indexOf('[[') + 2)
    expect(await source()).toBeNull()
  })

  it('does not open in indented code, inline code or front matter', async () => {
    const indented = 'Text\n\n    x = t[[]]\n'
    expect(await setup(indented, indented.indexOf('[[') + 2).source()).toBeNull()
    const inline = 'Use `t[[]]` here'
    expect(await setup(inline, inline.indexOf('[[') + 2).source()).toBeNull()
    const front = '---\ntags: [[]]\n---\nBody'
    expect(await setup(front, front.indexOf('[[') + 2).source()).toBeNull()
    // After the front matter it opens again.
    const after = '---\ntags: x\n---\nSee [[]]'
    expect(await setup(after, after.indexOf('[[') + 2).source()).not.toBeNull()
  })
})

describe('the card beside a highlighted note', () => {
  /** Just enough of a document to build the card. */
  const fakeDocument = () => ({
    createElement: () => ({
      className: '',
      textContent: '',
      children: [] as unknown[],
      append(...nodes: unknown[]) {
        this.children.push(...nodes)
      },
    }),
  })
  type Info = (completion: Completion) => Promise<{ children: { textContent: string }[] } | null>

  it('shows the note title and the start of its body', async () => {
    vi.stubGlobal('document', fakeDocument())
    try {
      const { source, sources } = setup('See [[gro]]', 9)
      sources.preview.mockResolvedValue({ title: 'Groceries', excerpt: 'Milk, eggs' })
      const [first] = await options(source)
      const node = await (first!.info as unknown as Info)(first!)
      expect(sources.preview).toHaveBeenCalledWith(ID)
      expect(node?.children.map((c) => c.textContent)).toEqual(['Groceries', 'Milk, eggs'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('shows nothing when the note cannot load, and none for New Note', async () => {
    const { source, sources } = setup('See [[gro]]', 9)
    sources.preview.mockRejectedValue(new Error('down'))
    const list = await options(source)
    expect(await (list[0]!.info as unknown as Info)(list[0]!)).toBeNull()
    expect(list[list.length - 1]?.info).toBeUndefined()
  })
})

describe('picking a note', () => {
  it('replaces [[query]] with the link', async () => {
    const { source, view } = setup('See [[gro]] now', 11 - 2)
    const [first] = await options(source)
    first?.apply(view, first, 4, 9)
    expect(view.state.doc.toString()).toBe(`See [Groceries](devot://note/${ID}) now`)
  })
})

describe('picking New Note', () => {
  it('links the note once it is made, replacing exactly [[query]]', async () => {
    const { source, view, made, type, sources } = setup('See [[Plan B]]', 12)
    const list = await options(source)
    const pick = list[list.length - 1]!
    pick.apply(view, pick, 4, 12)
    expect(sources.create).toHaveBeenCalledExactlyOnceWith('Plan B')
    // Typed while the note is made: before, and after the brackets.
    type(0, 'Top: ')
    type(view.state.doc.length, ' tail')
    made.settle(ID)
    await vi.waitFor(() => expect(sources.linked).toHaveBeenCalledWith(ID))
    expect(view.state.doc.toString()).toBe(`Top: See [Plan B](devot://note/${ID}) tail`)
    expect(sources.discard).not.toHaveBeenCalled()
  })

  it('puts the cursor after the link when it was still at the brackets', async () => {
    const { source, view, made } = setup('[[Plan B]]', 8)
    const list = await options(source)
    const pick = list[list.length - 1]!
    pick.apply(view, pick, 0, 8)
    made.settle(ID)
    await vi.waitFor(() => expect(view.state.doc.toString()).toContain('devot://note/'))
    expect(view.state.selection.main.head).toBe(view.state.doc.length)
  })

  it('keeps the cursor where the user moved it', async () => {
    const { source, view, made, type } = setup('[[Plan B]]', 8)
    const list = await options(source)
    const pick = list[list.length - 1]!
    pick.apply(view, pick, 0, 8)
    type(10, ' tail')
    view.dispatch({ selection: { anchor: 13 } })
    made.settle(ID)
    await vi.waitFor(() => expect(view.state.doc.toString()).toContain('devot://note/'))
    const link = `[Plan B](devot://note/${ID})`
    expect(view.state.doc.toString()).toBe(`${link} tail`)
    expect(view.state.selection.main.head).toBe(link.length + 3)
  })

  it('deletes the new note instead when the brackets were edited meanwhile', async () => {
    const { source, view, made, type, sources } = setup('[[Plan B]]', 8)
    const list = await options(source)
    const pick = list[list.length - 1]!
    pick.apply(view, pick, 0, 8)
    type(3, 'x')
    made.settle(ID)
    await vi.waitFor(() => expect(sources.discard).toHaveBeenCalledWith(ID))
    expect(view.state.doc.toString()).toBe('[[Pxlan B]]')
    expect(sources.linked).not.toHaveBeenCalled()
  })

  it('deletes the new note instead when the editor closed meanwhile', async () => {
    const { source, view, made, sources } = setup('[[Plan B]]', 8)
    const list = await options(source)
    const pick = list[list.length - 1]!
    pick.apply(view, pick, 0, 8)
    view.dom.isConnected = false
    made.settle(ID)
    await vi.waitFor(() => expect(sources.discard).toHaveBeenCalledWith(ID))
    expect(view.state.doc.toString()).toBe('[[Plan B]]')
  })

  it('changes nothing when the note could not be made', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { source, view, made, sources } = setup('[[Plan B]]', 8)
    const list = await options(source)
    const pick = list[list.length - 1]!
    pick.apply(view, pick, 0, 8)
    made.fail(new Error('E_X'))
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('W_LINK_NOTE_CREATE_FAILED'))
    expect(view.state.doc.toString()).toBe('[[Plan B]]')
    expect(sources.discard).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
