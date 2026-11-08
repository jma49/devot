// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { BookNode } from '../../core/books'
import type { AiAccessChange } from './aiAccess'
import { AiAccessDialog } from './AiAccessDialog'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const node = (
  id: string,
  name: string,
  aiAccess: boolean,
  children: BookNode[] = [],
  depth = 0,
): BookNode => ({
  id,
  name,
  parentId: null,
  depth,
  aiAccess,
  icon: null,
  iconColor: null,
  children,
})

const buildTree = (): BookNode[] => [
  node('work', 'Work', true, [node('work/projects', 'Projects', false, [], 1)]),
  node('home', 'Home', false),
]

const tree = buildTree()

const render = (counts = new Map<string, number>()): string =>
  renderToStaticMarkup(
    <AiAccessDialog tree={tree} counts={counts} onApply={() => {}} onCancel={() => {}} />,
  )

describe('AiAccessDialog', () => {
  it('lists every notebook with a checkbox that keeps its switch', () => {
    const html = render()
    expect(html.match(/type="checkbox"/g)).toHaveLength(3)
    expect(html.match(/checked=""/g)).toHaveLength(1)
    expect(html).toContain('Work')
    expect(html).toContain('Projects')
    expect(html).toContain('Home')
  })

  it('shows how many notes each notebook holds', () => {
    const html = render(new Map([['work', 3]]))
    expect(html).toContain('3 notes')
    expect(html).toContain('0 notes')
  })

  it('applies nothing until a switch differs from the notebook', () => {
    expect(render()).toContain('disabled=""')
  })
})

async function mount(initial: readonly BookNode[]) {
  const onApply = vi.fn<(changes: readonly AiAccessChange[]) => void>()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const show = (books: readonly BookNode[]) =>
    act(async () =>
      root.render(
        <AiAccessDialog tree={books} counts={new Map()} onApply={onApply} onCancel={() => {}} />,
      ),
    )
  await show(initial)
  const box = (name: string) =>
    [...host.querySelectorAll('label')]
      .find((label) => label.textContent?.includes(name))
      ?.querySelector('input') as HTMLInputElement
  const apply = () =>
    act(async () => {
      ;[...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Apply')
        ?.click()
    })
  const unmount = async () => {
    await act(async () => root.unmount())
    host.remove()
  }
  return { show, box, apply, onApply, unmount }
}

describe('AiAccessDialog while the library reloads', () => {
  it('keeps the ticks made before an equal tree arrives as a new array', async () => {
    const view = await mount(buildTree())
    await act(async () => view.box('Work').click())
    await view.show(buildTree())
    expect(view.box('Work').checked).toBe(false)
    await view.apply()
    expect(view.onApply).toHaveBeenCalledWith([{ id: 'work', on: false }])
    await view.unmount()
  })

  it('drops a ticked notebook that no longer exists', async () => {
    const view = await mount(buildTree())
    await act(async () => view.box('Home').click())
    await act(async () => view.box('Work').click())
    await view.show(buildTree().filter((book) => book.id !== 'home'))
    await view.apply()
    expect(view.onApply).toHaveBeenCalledWith([{ id: 'work', on: false }])
    await view.unmount()
  })

  it('starts from the stored switches once the notebooks load', async () => {
    const view = await mount([])
    await view.show(buildTree())
    expect(view.box('Work').checked).toBe(true)
    expect(view.box('Projects').checked).toBe(false)
    expect(view.box('Home').checked).toBe(false)
    await view.unmount()
  })
})
