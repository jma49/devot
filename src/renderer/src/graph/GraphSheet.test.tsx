// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { GraphView } from '../../../core/graph'
import { settle } from '../../../../tests/support/render-hook'
import type { Core } from '../core-client'
import { GraphSheet, requestGraph, useGraphCommand } from './GraphSheet'

const view: GraphView = {
  notes: [
    { id: 'a', title: 'Alpha', x: 0, y: 0, links: 1 },
    { id: 'b', title: '', x: 40, y: 0, links: 1 },
  ],
  links: [[0, 1]],
  capped: false,
}

let root: Root | undefined

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

function show(core: Partial<Core>, focus: string | null = 'a') {
  const calls = { open: vi.fn<(id: string) => void>(), close: vi.fn<() => void>() }
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <GraphSheet
        core={core as Core}
        focus={focus ?? undefined}
        onOpenNote={calls.open}
        onClose={calls.close}
      />,
    ),
  )
  return calls
}

const button = (name: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === name)

describe('the graph sheet', () => {
  it("shows the open note's graph first, and every note's on All Notes", async () => {
    const linkGraph = vi.fn<(focus?: string) => Promise<GraphView>>(() => Promise.resolve(view))
    show({ linkGraph } as unknown as Partial<Core>)
    await settle()
    expect(linkGraph).toHaveBeenLastCalledWith('a')
    expect(document.querySelector('.graph-count')?.textContent).toBe('2 notes · 1 link')
    act(() => button('All Notes')!.click())
    await settle()
    expect(linkGraph).toHaveBeenLastCalledWith(undefined)
  })

  it('offers no scope without an open note', async () => {
    const linkGraph = vi.fn<(focus?: string) => Promise<GraphView>>(() => Promise.resolve(view))
    show({ linkGraph } as unknown as Partial<Core>, null)
    await settle()
    expect(linkGraph).toHaveBeenCalledWith(undefined)
    expect(button('This Note')).toBeUndefined()
  })

  it('opens a note from its list, naming an untitled one, and closes', async () => {
    const calls = show({ linkGraph: () => Promise.resolve(view) } as unknown as Partial<Core>)
    await settle()
    act(() => button('Untitled')!.click())
    expect(calls.close).toHaveBeenCalled()
    expect(calls.open).toHaveBeenCalledWith('b')
  })

  it('keeps only the answer to the scope asked last', async () => {
    let answer: ((v: GraphView) => void) | undefined
    const late = new Promise<GraphView>((resolve) => (answer = resolve))
    const linkGraph = vi
      .fn<(focus?: string) => Promise<GraphView>>()
      .mockReturnValueOnce(late)
      .mockResolvedValue({ ...view, notes: view.notes.slice(0, 1), links: [] })
    show({ linkGraph } as unknown as Partial<Core>)
    act(() => button('All Notes')!.click())
    await settle()
    answer!(view)
    await settle()
    expect(document.querySelector('.graph-count')?.textContent).toBe('1 note · 0 links')
  })

  it('says when it could not be drawn', async () => {
    show({ linkGraph: () => Promise.reject(new Error('E_TEST')) } as unknown as Partial<Core>)
    await settle()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'The graph could not be drawn.',
    )
  })
})

describe('Show Graph', () => {
  it('opens the sheet from the command', () => {
    const open = vi.fn<() => void>()
    function Host() {
      useGraphCommand(open)
      return null
    }
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(<Host />))
    requestGraph()
    expect(open).toHaveBeenCalledTimes(1)
  })
})
