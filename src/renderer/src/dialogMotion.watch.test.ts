// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchDialogExits } from './dialogMotion'

const settled = () => new Promise((done) => setTimeout(done, 0))

describe('watchDialogExits', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('looks for dialogs in what the app adds, but not in a render of the note', async () => {
    document.body.innerHTML =
      '<main><article data-devot-part="preview"><div class="preview-body"></div></article></main>'
    const content = document.querySelector('.preview-body')!
    const stop = watchDialogExits(document.body)
    const search = vi.spyOn(Element.prototype, 'querySelectorAll')
    for (let i = 0; i < 50; i += 1) {
      const block = document.createElement('p')
      block.append(document.createElement('strong'))
      content.append(block)
    }
    content.firstElementChild!.firstElementChild!.append(document.createElement('em'))
    await settled()
    expect(search).not.toHaveBeenCalled()
    document.querySelector('main')!.append(document.createElement('section'))
    await settled()
    expect(search).toHaveBeenCalledWith('dialog')
    stop()
  })
})
