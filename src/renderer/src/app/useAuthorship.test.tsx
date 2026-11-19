// @vitest-environment happy-dom
import {
  createRef,
  type Dispatch,
  type ReactElement,
  type RefObject,
  type SetStateAction,
} from 'react'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderHook, settle, unmountAll } from '../../../../tests/support/render-hook'
import { agentWritesView } from '../agentWrites'
import type { Core } from '../core-client'
import type { Mode } from '../ModeControl'
import type { EditorHandle } from '../editor/handle'
import { useAuthorshipNotice, useShownWrites } from './useAuthorship'

afterEach(unmountAll)

const NOTE = 'note-1'

function fakeEditor() {
  const listeners = new Set<() => void>()
  const handle = {
    noteId: NOTE,
    changed: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  } as unknown as EditorHandle
  return {
    handle,
    type: () => listeners.forEach((listener) => listener()),
    listening: () => listeners.size,
  }
}

function setUp() {
  const core = {
    flush: async () => {},
    undoAgentWrite: async () => ({
      update: new Uint8Array(),
      dropped: 0,
      restore: { token: 'token-1', writes: ['w1', 'w2'] },
    }),
  } as unknown as Core
  const agentWrites = {
    view: agentWritesView([
      {
        noteId: NOTE,
        writeId: 'w1',
        kind: 'mcp',
        name: 'Agent',
        at: 1,
        created: false,
        seen: false,
      },
    ]),
    reload: async () => {},
  } as never
  const editorRef: RefObject<EditorHandle | null> = createRef<EditorHandle | null>()
  const props = (editorHandle: EditorHandle | null) => {
    ;(editorRef as { current: EditorHandle | null }).current = editorHandle
    return {
      core,
      editing: true,
      selected: NOTE,
      inTrash: false,
      multiIds: undefined,
      selectedIsTemplate: false,
      mode: 'edit' as Mode,
      setMode: vi.fn<Dispatch<SetStateAction<Mode>>>(),
      editorMode: { current: 'edit' as Mode },
      agentWrites,
      shown: {
        shownWrites: { current: undefined },
        markShownSeen: async () => {},
        markWriteSeen: async () => undefined,
        forgetShownWrite: () => {},
        reloadAgentWrites: async () => {},
      } as unknown as ReturnType<typeof useShownWrites>,
      editorRef,
      editorHandle,
      restoreRef: { current: null },
      setChangeNotice: vi.fn<Dispatch<SetStateAction<string | undefined>>>(),
    }
  }
  return {
    props,
    hook: (first: EditorHandle) => renderHook(useAuthorshipNotice, { props: props(first) }),
  }
}

it('takes the Restore offer back on a change in an editor that replaced the one offered in', async () => {
  const { props, hook: render } = setUp()
  const first = fakeEditor()
  const second = fakeEditor()
  const hook = render(first.handle)
  await act(async () => {
    await (
      hook.current.authorshipNotice as ReactElement<{
        onUndoWrite: (id: string) => unknown
      }>
    ).props.onUndoWrite('w1')
  })
  await settle()
  expect(
    (hook.current.authorshipNotice as ReactElement<{ restore?: unknown }>).props.restore,
  ).toBeDefined()
  expect(first.listening()).toBe(1)

  hook.rerender(props(second.handle))
  expect(first.listening()).toBe(0)
  expect(second.listening()).toBe(1)

  act(() => second.type())
  expect(
    (hook.current.authorshipNotice as ReactElement<{ restore?: unknown }>).props.restore,
  ).toBeUndefined()
})
