// @vitest-environment happy-dom
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { expect, it, vi } from 'vitest'
import { vimMode } from './vim'

it('drops an import resolved after Vim is disabled, even if enabled again', async () => {
  let resolve!: (extension: ReturnType<typeof keymap.of>) => void
  const pending = new Promise<ReturnType<typeof keymap.of>>((done) => {
    resolve = done
  })
  const run = vi.fn<() => boolean>(() => true)
  const slot = new Compartment()
  const extension = vimMode(() => pending)
  const view = new EditorView({ state: EditorState.create({ extensions: slot.of(extension) }) })
  try {
    view.dispatch({ effects: slot.reconfigure([]) })
    resolve(keymap.of([{ key: 'x', run }]))
    await pending
    await Promise.resolve()
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
    expect(run).not.toHaveBeenCalled()
    view.dispatch({ effects: slot.reconfigure(extension) })
    await vi.waitFor(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
      expect(run).toHaveBeenCalledOnce()
    })
  } finally {
    view.destroy()
  }
})

it('leaves ordinary keys usable when loading fails and can load after re-enabling', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const load = vi
    .fn<() => Promise<Extension>>()
    .mockRejectedValueOnce(new Error('failure'))
    .mockResolvedValueOnce([])
  const slot = new Compartment()
  const extension = vimMode(load)
  const view = new EditorView({ state: EditorState.create({ extensions: slot.of(extension) }) })
  try {
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('W_EDITOR_VIM_LOAD_FAILED'))
    expect(
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }),
      ),
    ).toBe(true)
    view.dispatch({ effects: slot.reconfigure([]) })
    view.dispatch({ effects: slot.reconfigure(extension) })
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  } finally {
    view.destroy()
    warn.mockRestore()
  }
})
