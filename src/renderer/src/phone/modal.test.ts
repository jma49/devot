import { describe, expect, it } from 'vitest'
import { holdModal, isTopModal, modalOpen, watchModals, type ModalNode } from './modal'

interface Node extends ModalNode {
  children: Node[]
  parentElement: Node | null
}

function node(...children: Node[]): Node {
  const made: Node = { parentElement: null, children, inert: false }
  for (const child of children) child.parentElement = made
  return made
}

function add(parent: Node, child: Node): Node {
  child.parentElement = parent
  parent.children.push(child)
  return child
}

const inertOf = (...nodes: Node[]) => nodes.map((n) => n.inert)

describe('holdModal', () => {
  it('makes the siblings of the layer and of its ancestors inert, and gives them back', () => {
    const screen = node()
    const tabBar = node()
    const app = node(screen, tabBar)
    const toast = node()
    const body = node(app, toast)
    const layer = add(app, node())
    const release = holdModal(layer)
    expect(inertOf(screen, tabBar, toast, layer, app, body)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ])
    release()
    expect(inertOf(screen, tabBar, toast)).toEqual([false, false, false])
  })

  it('stacks: a sheet over a sheet makes the lower one inert until it closes', () => {
    const screen = node()
    const app = node(screen)
    const lower = add(app, node())
    const releaseLower = holdModal(lower)
    const upper = add(app, node())
    const releaseUpper = holdModal(upper)
    expect(inertOf(screen, lower, upper)).toEqual([true, true, false])
    expect(isTopModal(upper)).toBe(true)
    releaseUpper()
    app.children.pop()
    expect(inertOf(screen, lower)).toEqual([true, false])
    expect(isTopModal(lower)).toBe(true)
    releaseLower()
    expect(inertOf(screen, lower)).toEqual([false, false])
    expect(isTopModal(lower)).toBe(false)
  })

  it('leaves an element that was inert before it inert after', () => {
    const asleep = node()
    asleep.inert = true
    const app = node(asleep)
    const release = holdModal(add(app, node()))
    release()
    expect(asleep.inert).toBe(true)
  })

  it('releasing twice does nothing more', () => {
    const screen = node()
    const app = node(screen)
    const release = holdModal(add(app, node()))
    release()
    const other = holdModal(add(app, node()))
    release()
    expect(screen.inert).toBe(true)
    other()
    expect(screen.inert).toBe(false)
  })

  it('tells a watcher when the first layer comes and the last one goes', () => {
    const app = node()
    const seen: boolean[] = []
    const unwatch = watchModals(() => seen.push(modalOpen()))
    const releaseSheet = holdModal(add(app, node()))
    const releasePicker = holdModal(add(app, node()))
    releasePicker()
    releaseSheet()
    releaseSheet()
    unwatch()
    holdModal(add(app, node()))()
    expect(seen).toStrictEqual([true, false])
    expect(modalOpen()).toBe(false)
  })
})
