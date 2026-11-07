import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EmptyTrashButton } from './EmptyTrashButton'

const render = (disabled: boolean) =>
  renderToStaticMarkup(<EmptyTrashButton disabled={disabled} onClick={() => undefined} />)

describe('the Empty Trash button', () => {
  it('is a round icon tool named Empty Trash, like New Note', () => {
    const html = render(false)
    expect(html).toContain('class="tool list-create"')
    expect(html).toContain('aria-label="Empty Trash"')
    expect(html).toContain('title="Empty Trash"')
    expect(html).toMatch(/lucide-archive-x|xmark\.bin/)
    expect(html).not.toContain('>Empty Trash<')
    expect(html).not.toContain('aria-disabled="true"')
  })

  it('stays focusable but marked disabled when there is nothing to empty', () => {
    const html = render(true)
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/)
  })
})
