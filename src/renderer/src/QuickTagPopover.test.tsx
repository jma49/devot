// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TagColorValue } from '../../core/storage'
import { settle } from '../../../tests/support/render-hook'
import { QuickTag } from './QuickTagPopover'

const unmounts: (() => void)[] = []
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount()
})

type Create = (name: string, color: TagColorValue | null) => Promise<string | undefined>

function open(onCreate: Create) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() =>
    root.render(
      <QuickTag
        tags={[]}
        onNote={[]}
        counts={new Map()}
        onPut={() => {}}
        onCreate={onCreate}
        onClose={() => {}}
      />,
    ),
  )
  unmounts.push(() => {
    act(() => root.unmount())
    host.remove()
  })
  const field = () => host.querySelector<HTMLInputElement>('.quick-tag-field')!
  const swatch = (name: string) =>
    host.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${name}"]`)
  return {
    field,
    swatch,
    type: (text: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          field(),
          text,
        )
        field().dispatchEvent(new Event('input', { bubbles: true }))
      }),
    pick: (name: string) => act(() => swatch(name)?.click()),
    enter: () =>
      act(() => {
        field().dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        )
      }),
  }
}

describe('QuickTag', () => {
  it('keeps the typed name and the colour when making the tag is refused', async () => {
    const onCreate = vi.fn<Create>(async () => undefined)
    const quick = open(onCreate)
    quick.type('fresh')
    quick.pick('Green')
    quick.enter()
    await settle()
    expect(onCreate).toHaveBeenCalledExactlyOnceWith('fresh', 'green')
    expect(quick.field().value).toBe('fresh')
    expect(quick.swatch('Green')?.getAttribute('aria-checked')).toBe('true')
  })

  it('clears both once the tag is made', async () => {
    const quick = open(async () => 'tag-1')
    quick.type('fresh')
    quick.pick('Green')
    quick.enter()
    await settle()
    expect(quick.field().value).toBe('')
    expect(quick.swatch('Green')).toBeNull()
  })

  it('makes the tag once while the first Return is still making it', async () => {
    let finish: (id: string | undefined) => void = () => {}
    const onCreate = vi.fn<Create>(() => new Promise((resolve) => (finish = resolve)))
    const quick = open(onCreate)
    quick.type('fresh')
    quick.enter()
    quick.enter()
    expect(onCreate).toHaveBeenCalledOnce()
    finish('tag-1')
    await settle()
    expect(quick.field().value).toBe('')
  })
})
