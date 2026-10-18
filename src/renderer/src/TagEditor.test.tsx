import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TagEditor } from './TagEditor'

vi.mock('./icons/Icon', () => ({ Icon: () => null }))

describe('the tag field', () => {
  it('points aria-controls at nothing while the suggestions are closed', () => {
    const html = renderToStaticMarkup(
      <TagEditor tags={[]} value={[]} onAdd={() => {}} onRemove={() => {}} />,
    )
    expect(html).toContain('role="combobox"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('aria-controls')
  })
})
