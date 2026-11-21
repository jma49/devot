// @vitest-environment happy-dom
import { EditorView } from '@codemirror/view'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { BODY } from '../../core/notes'
import type { Core } from './core-client'
import type { EditorHandle } from './editor/handle'
import type { LinkSources } from './linkCompletion'
import { settle } from '../../../tests/support/render-hook'
import { NoteEditor } from './NoteEditor'

vi.hoisted(() => Object.assign(globalThis, { DEVOT_UI_TEST: false }))
vi.mock('./ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>(async () => undefined) }))

const unmounts: (() => void)[] = []
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount()
  document.body.replaceChildren()
})

const links: LinkSources = {
  find: async () => [],
  create: async () => '',
  discard: async () => {},
  linked: () => {},
}

const stateOf = (body: string) => {
  const doc = new Y.Doc()
  doc.getText(BODY).insert(0, body)
  return Y.encodeStateAsUpdate(doc)
}

/** A NoteEditor whose core opens each note in `bodies`; a body still pending keeps the note loading. */
function editorOver(bodies: Record<string, string | Promise<string>>) {
  const core = {
    hold: async () => {},
    unhold: async () => {},
    applyUpdate: async () => {},
    noteCounts: async () => ({ words: 0, characters: 0 }),
    open: async (id: string) => ({ state: stateOf(await (bodies[id] ?? '')) }),
  } as unknown as Core
  const handleRef: { current: EditorHandle | null } = { current: null }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const show = async (noteId: string) => {
    act(() =>
      root.render(
        createElement(NoteEditor, {
          core,
          noteId,
          autoFocus: false,
          hidden: false,
          onText: () => {},
          links,
          showAlertMenu: async () => undefined,
          handleRef,
        }),
      ),
    )
    await settle()
  }
  unmounts.push(() => act(() => root.unmount()))
  const view = () => {
    const content = host.querySelector('div')?.shadowRoot?.querySelector('.cm-content')
    const found = content instanceof HTMLElement && EditorView.findFromDOM(content)
    if (!found) throw new Error('no editor')
    return found
  }
  const takesTyping = () =>
    view().state.facet(EditorView.editable) &&
    !view().state.readOnly &&
    view().contentDOM.getAttribute('aria-hidden') === null
  return { show, handleRef, view, takesTyping }
}

const later = () => {
  let arrive: (body: string) => void = () => {}
  const body = new Promise<string>((resolve) => (arrive = resolve))
  return { body, arrive }
}

describe('New Note in the editor', () => {
  it('ends the pause when the user goes back to the note still shown', async () => {
    const { show, handleRef, view, takesTyping } = editorOver({
      shown: 'Target',
      new: later().body,
    })
    await show('shown')
    const end = handleRef.current?.pauseForNewNote()
    await show('new')
    await show('shown')
    expect(view().state.doc.toString()).toBe('Target')
    expect(takesTyping()).toBe(true)
    end?.()
    expect(takesTyping()).toBe(true)
  })

  it('keeps the note left paused until the new one shows, which takes typing', async () => {
    const made = later()
    const { show, handleRef, view, takesTyping } = editorOver({ shown: 'Target', new: made.body })
    await show('shown')
    const end = handleRef.current?.pauseForNewNote()
    await show('new')
    end?.()
    expect(takesTyping()).toBe(false)
    made.arrive('')
    await settle()
    expect(handleRef.current?.noteId).toBe('new')
    expect(view().state.doc.toString()).toBe('')
    expect(takesTyping()).toBe(true)
  })
})

describe('a native capture in the editor', () => {
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ])

  it('puts a scan’s pages on lines of their own at the caret, and a transcript as typed', async () => {
    const { storage } = await import('./core-client')
    const put = vi.spyOn(storage, 'putFile').mockResolvedValue(undefined)
    const { show, handleRef, view } = editorOver({ a: 'Before after' })
    await show('a')
    act(() => view().dispatch({ selection: { anchor: 7 } }))
    const refused = await handleRef.current!.attach({
      images: [new File([PNG], 'scan-1.png')],
      text: '',
    })
    expect(refused).toStrictEqual([])
    expect(put).toHaveBeenCalledTimes(1)
    expect(view().state.doc.toString()).toMatch(
      /^Before \n!\[scan-1\]\(devot:\/\/file\/[^)]+\)\nafter$/,
    )
    act(() => view().dispatch({ selection: { anchor: view().state.doc.length } }))
    await handleRef.current!.attach({ images: [], text: ' Said aloud.' })
    expect(view().state.doc.toString()).toMatch(/after Said aloud\.$/)
  })

  it('reports an image storage refuses and inserts nothing for it', async () => {
    const { show, handleRef, view } = editorOver({ a: 'Text' })
    await show('a')
    const refused = await handleRef.current!.attach({
      images: [new File([new Uint8Array([1, 2, 3])], 'scan-1.jpg')],
      text: '',
    })
    expect(refused).toStrictEqual(['E_FILE_TYPE_REFUSED'])
    expect(view().state.doc.toString()).toBe('Text')
  })
})
