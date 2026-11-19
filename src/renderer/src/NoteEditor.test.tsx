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
