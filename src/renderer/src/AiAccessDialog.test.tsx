import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BookNode } from '../../core/books'
import { AiAccessDialog } from './AiAccessDialog'

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

const tree = [
  node('work', 'Work', true, [node('work/projects', 'Projects', false, [], 1)]),
  node('home', 'Home', false),
]

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
