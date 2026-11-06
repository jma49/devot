import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DateValue } from './NoteInfo'
import type { InfoField } from './infoCard'

vi.mock('../icons/Icon', () => ({ Icon: () => null }))

const field: InfoField = {
  key: 'created',
  icon: 'progress',
  label: 'Created at',
  value: 'Jan 5, 2026',
  dateTime: '2026-01-05T10:00:00.000Z',
}

describe('an editable date of the info card', () => {
  it('names the field, the date and the action for a screen reader', () => {
    const html = renderToStaticMarkup(
      <DateValue field={field} at={0} onSet={() => Promise.resolve('saved')} />,
    )
    expect(html).toContain('aria-label="Created at: Jan 5, 2026. Change the date"')
  })

  it('is plain text when the date cannot be changed', () => {
    const html = renderToStaticMarkup(<DateValue field={field} at={0} />)
    expect(html).not.toContain('<button')
  })
})
