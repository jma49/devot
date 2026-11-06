import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ListHeader, type ListHeaderProps } from './ListHeader'

function header(props: Partial<ListHeaderProps> = {}): string {
  return renderToStaticMarkup(
    <ListHeader
      title="Data Structures and Algorithms"
      count={6}
      onCreate={() => undefined}
      filter={<div className="search-field" />}
      sort={{ label: 'Sort', chip: 'Date Updated', onOpen: () => undefined }}
      layout={<div className="layout-control" />}
      onFilterDone={() => undefined}
      {...props}
    />,
  )
}

const toolbar = (html: string) => html.slice(0, html.indexOf('class="list-filter"'))
const newNote = /<button[^>]*aria-label="New Note"[^>]*>/

describe('the note list header', () => {
  it('holds the sidebar toggle and the name over the count, and no New Note', () => {
    const html = header({ leading: <button className="sidebar-toggle">Toggle</button> })
    const bar = toolbar(html)
    expect(bar).toContain('sidebar-toggle')
    expect(bar).toContain('class="headline"')
    expect(bar).toContain('class="list-count"')
    expect(bar).not.toContain('New Note')
    expect(bar).not.toContain('list-header-end')
  })

  it('puts New Note last on the search row, with its name, tooltip and action', () => {
    const html = header()
    const row = html.slice(html.indexOf('class="list-filter"'))
    const search = row.indexOf('search-field')
    const create = row.search(newNote)
    expect(search).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(search)
    const button = row.match(newNote)![0]
    expect(button).toContain('title="New Note"')
    expect(button).toContain('class="tool list-create"')
    expect(button).not.toContain('disabled')
    expect(row.indexOf('layout-control')).toBeGreaterThan(-1)
  })

  it('uses the given label and disables New Note when nothing can be created', () => {
    const html = header({ createLabel: 'New Template', onCreate: undefined })
    const button = html.match(/<button[^>]*aria-label="New Template"[^>]*>/)![0]
    expect(button).toContain('disabled')
    expect(button).toContain('title="New Template"')
  })

  it("shows a view-specific action in New Note's place", () => {
    const html = header({ headerAction: <button className="button">Empty Trash</button> })
    expect(html).not.toContain('New Note')
    const row = html.slice(html.indexOf('class="list-filter"'))
    expect(row.indexOf('Empty Trash')).toBeGreaterThan(row.indexOf('search-field'))
  })
})
