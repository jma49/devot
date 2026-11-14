// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_EDITOR_SETTINGS } from '../../../../core/editorSettings'
import { editorFind, editorFindTarget } from '../../editor/find'
import { editorSetup } from '../../editor/settings'
import type { FindTarget } from '../../find/target'
import {
  createEditorSlot,
  editorHandlers,
  NO_FIND_COUNT,
  runFind,
  type NativeEditor,
} from './editor'
import { pageScrolls, setFootInset } from './pageScroll'

function slotOf(native: NativeEditor) {
  const slot = createEditorSlot()
  slot.ref(native)
  return slot
}

function nativeEditor(target: () => FindTarget | null): NativeEditor {
  return {
    show: () => {},
    hide: async () => {},
    setMode: () => {},
    focus: async () => false,
    format: () => {},
    ai: () => {},
    find: (action, query) => runFind(target(), action, query),
    insets: setFootInset,
    duplicate: async () => null,
  }
}

function editor(doc: string) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [editorFind(), editorSetup(DEFAULT_EDITOR_SETTINGS)],
    }),
    parent: document.body,
  })
  return { view, target: editorFindTarget(view) }
}

const footMargin = (view: EditorView) =>
  view.state
    .facet(EditorView.scrollMargins)
    .reduce((sum, margin) => sum + (margin(view)?.bottom ?? 0), 0)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setFootInset(0)
  pageScrolls(false)
  document.body.innerHTML = ''
})

describe('the keyboard insets Swift sends', () => {
  it('apply at once, and the caret keeps clear of the keyboard', async () => {
    const { view } = editor('one\ntwo')
    const before = footMargin(view)
    const handlers = editorHandlers(slotOf(nativeEditor(() => null)), { prepare: () => {} })
    const frames = vi.spyOn(window, 'requestAnimationFrame')
    await handlers['editor.insets']!({ bottom: 336.5, duration: 0.25, curve: 7 })
    expect(document.documentElement.style.getPropertyValue('--editor-foot-inset')).toBe('336.5px')
    expect(footMargin(view)).toBe(before + 336.5)
    // UIKit already animates the keyboard: the page jumps to the final room.
    expect(frames).not.toHaveBeenCalled()
    expect(document.documentElement.style.transition).toBe('')
    await handlers['editor.insets']!({ bottom: 0, duration: 0.25, curve: 7 })
    expect(document.documentElement.style.getPropertyValue('--editor-foot-inset')).toBe('')
    expect(footMargin(view)).toBe(before)
  })

  // Issue #885: WebKit ends the visual viewport above the keyboard, so counting the keyboard again
  // scrolled the caret's line under the navigation bar on the first key typed.
  it('keep the caret clear of the keyboard without counting what the visual viewport leaves out', () => {
    const { view } = editor('one\ntwo')
    const before = footMargin(view)
    const viewport = (height: number) =>
      vi.stubGlobal('visualViewport', { height } as VisualViewport)
    setFootInset(400)
    viewport(window.innerHeight - 400)
    expect(footMargin(view)).toBe(before)
    viewport(window.innerHeight - 340)
    expect(footMargin(view)).toBe(before + 60)
    viewport(window.innerHeight)
    expect(footMargin(view)).toBe(before + 400)
  })

  it('refuses a negative or endless inset', async () => {
    const handlers = editorHandlers(slotOf(nativeEditor(() => null)), { prepare: () => {} })
    await expect(handlers['editor.insets']!({ bottom: -1 })).rejects.toThrow(
      'E_SCREENS_ARGS_INVALID',
    )
    await expect(handlers['editor.insets']!({ bottom: Infinity })).rejects.toThrow(
      'E_SCREENS_ARGS_INVALID',
    )
  })

  it('mark the page as scrolling itself only while asked', () => {
    pageScrolls(true)
    expect(document.documentElement.hasAttribute('data-page-scrolls')).toBe(true)
    pageScrolls(false)
    expect(document.documentElement.hasAttribute('data-page-scrolls')).toBe(false)
  })
})

describe('the native find bar', () => {
  it('drives the editor’s search and counts from one', async () => {
    const { view, target } = editor('cat dog Cat cat')
    const handlers = editorHandlers(slotOf(nativeEditor(() => target)), { prepare: () => {} })
    expect(await handlers['editor.find']!({ action: 'search', query: 'cat' })).toStrictEqual({
      total: 3,
      current: 1,
      capped: false,
    })
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'cat',
    )
    expect(await handlers['editor.find']!({ action: 'next' })).toMatchObject({ current: 2 })
    expect(await handlers['editor.find']!({ action: 'previous' })).toMatchObject({ current: 1 })
    // Each key typed in the bar searches again, so the count follows the query.
    expect(await handlers['editor.find']!({ action: 'search', query: 'cat d' })).toMatchObject({
      total: 1,
    })
    expect(await handlers['editor.find']!({ action: 'search', query: 'cow' })).toStrictEqual(
      NO_FIND_COUNT,
    )
    expect(await handlers['editor.find']!({ action: 'close' })).toStrictEqual(NO_FIND_COUNT)
    expect(target.status().total).toBe(0)
  })

  it('refuses a search without a query, and a step with one', async () => {
    const handlers = editorHandlers(slotOf(nativeEditor(() => null)), { prepare: () => {} })
    await expect(handlers['editor.find']!({ action: 'search' })).rejects.toThrow(
      'E_SCREENS_ARGS_INVALID',
    )
    await expect(handlers['editor.find']!({ action: 'next', query: 'a' })).rejects.toThrow(
      'E_SCREENS_ARGS_INVALID',
    )
    await expect(handlers['editor.find']!({ action: 'replace' })).rejects.toThrow(
      'E_SCREENS_ARGS_INVALID',
    )
  })

  it('finds nothing before the editor is there', async () => {
    const handlers = editorHandlers(slotOf(nativeEditor(() => null)), { prepare: () => {} })
    expect(await handlers['editor.find']!({ action: 'search', query: 'a' })).toStrictEqual(
      NO_FIND_COUNT,
    )
  })
})
