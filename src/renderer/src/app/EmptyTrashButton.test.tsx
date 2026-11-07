// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { EmptyTrashButton } from './EmptyTrashButton'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const render = (disabled: boolean) =>
  renderToStaticMarkup(<EmptyTrashButton disabled={disabled} onClick={() => undefined} />)

async function click(disabled: boolean) {
  const onClick = vi.fn<() => void>()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<EmptyTrashButton disabled={disabled} onClick={onClick} />))
  host.querySelector('button')?.click()
  await act(async () => root.unmount())
  host.remove()
  return onClick
}

describe('the Empty Trash button', () => {
  it('is a round icon tool named Empty Trash, like New Note', () => {
    const html = render(false)
    expect(html).toContain('class="tool list-create"')
    expect(html).toContain('aria-label="Empty Trash"')
    expect(html).toContain('title="Empty Trash"')
    expect(html).toContain('data-symbol="xmark.bin"')
    expect(html).not.toContain('>Empty Trash<')
    expect(html).not.toContain('aria-disabled="true"')
  })

  it('stays focusable but marked disabled when there is nothing to empty', () => {
    const html = render(true)
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/)
  })

  it('calls onClick when clicked', async () => {
    expect(await click(false)).toHaveBeenCalledTimes(1)
  })
})
