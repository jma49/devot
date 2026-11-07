import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TagRecord } from '../../core/storage'
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

describe('a tag chip', () => {
  const tag: TagRecord = {
    id: 't1',
    name: 'trip',
    nameHlc: '',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    deletedHlc: null,
    color: null,
    colorHlc: '',
  }

  it('holds its name in a label of its own, so the x can fade the end of it', () => {
    const html = renderToStaticMarkup(
      <TagEditor tags={[tag]} value={['t1']} onAdd={() => {}} onRemove={() => {}} />,
    )
    expect(html).toMatch(
      /<span class="chip-label">trip<\/span><button type="button" class="chip-remove"/,
    )
  })
})
