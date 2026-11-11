// @vitest-environment happy-dom
import { act, useLayoutEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '../../core'
import { renderHook, unmountAll } from '../../../tests/support/render-hook'
import type { Core } from './core-client'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', true))

const { useActivityMenu } = await import('./Activity')
const { usePaneTab } = await import('./areas')
const { useWindowCommands } = await import('./commands/dispatch')
const { dbChanged, useExternalChanges } = await import('./externalChanges')
const { useHeadlines } = await import('./headlines')
const { useStable } = await import('./stable')
const { useWarmUp } = await import('./warmUp')

afterEach(() => {
  unmountAll()
  document.body.replaceChildren()
})

/**
 * Renders `use(count)` at 0, then at 1, and runs `fire` in a layout effect of the commit that
 * puts 1 on screen: where an event lands that follows a change at once, before any passive effect.
 */
function afterChange(use: (count: number) => void, fire: () => void) {
  const hook = renderHook(
    () => {
      const [count, setCount] = useState(0)
      use(count)
      useLayoutEffect(() => {
        if (count === 1) fire()
      }, [count])
      return setCount
    },
    { props: undefined },
  )
  act(() => hook.current(1))
}

describe('a handler kept for a listener is the one of the render on screen', () => {
  it('useStable', () => {
    const seen: number[] = []
    let run = () => {}
    afterChange(
      (count) => {
        run = useStable(() => void seen.push(count))
      },
      () => run(),
    )
    expect(seen).toEqual([1])
  })

  it("a window command's key", () => {
    const seen: number[] = []
    afterChange(
      (count) => useWindowCommands({ 'view.sidebar': { run: () => void seen.push(count) } }),
      () =>
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: '/',
            code: 'Slash',
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
    )
    expect(seen).toEqual([1])
  })

  it('the Activity menu item', () => {
    const seen: number[] = []
    afterChange(
      (count) => useActivityMenu(() => void seen.push(count)),
      () => window.dispatchEvent(new CustomEvent('devot:show-activity')),
    )
    expect(seen).toEqual([1])
  })

  it('Tab between the panes', () => {
    const seen: number[] = []
    const editor = document.createElement('div')
    editor.className = 'cm-content'
    document.body.append(editor)
    afterChange(
      (count) => usePaneTab(() => void seen.push(count)),
      () =>
        editor.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Tab',
            code: 'Tab',
            bubbles: true,
            cancelable: true,
          }),
        ),
    )
    expect(seen).toEqual([1])
  })

  it('a reload after a change from outside', () => {
    const seen: number[] = []
    afterChange(
      (count) =>
        useExternalChanges(() => {
          seen.push(count)
          return Promise.resolve()
        }),
      () => window.dispatchEvent(dbChanged()),
    )
    expect(seen).toEqual([1])
  })

  it('the warm-up of the open note', () => {
    const warmFeatures = vi.fn<(text: string, listed: string[]) => Promise<never>>(
      () => new Promise(() => {}),
    )
    const core = { warmFeatures } as unknown as Core
    const tasks: (() => void)[] = []
    afterChange(
      (count) =>
        useWarmUp(
          core,
          true,
          () => `text ${count}`,
          [],
          (task) => void tasks.push(task),
        ),
      () => tasks[0]?.(),
    )
    expect(warmFeatures).toHaveBeenCalledWith('text 1', [])
  })

  it('a headline answered for the loader before', () => {
    const answers: ((found: Record<string, string>) => void)[] = []
    const asked = () => {
      const chain = {
        then(done: (found: Record<string, string>) => void) {
          answers.push(done)
          return chain
        },
        catch: () => chain,
        finally: () => chain,
      }
      return chain as unknown as Promise<Record<string, string>>
    }
    const before = () => asked()
    const now = () => new Promise<Record<string, string>>(() => {})
    const notes = [{ id: 'n', title: '', updatedAt: 1 } as NoteSummary]
    let shown: ReadonlyMap<string, string> = new Map()
    afterChange(
      (count) => {
        shown = useHeadlines(count === 0 ? before : now, notes)
      },
      () => answers[0]?.({ n: 'read for the loader before' }),
    )
    expect(answers).toHaveLength(1)
    expect([...shown]).toEqual([])
  })
})
