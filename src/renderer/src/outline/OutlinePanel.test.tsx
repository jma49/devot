import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { outlineHeadings } from './headings'
import { lineStore, OutlineTree } from './OutlinePanel'

vi.mock('../icons/Icon', () => ({ Icon: () => null }))

const headings = outlineHeadings('# One\n## Alpha\n### Deep\n## Beta\n# Two\n')

function html(line: number, folded: string[] = []) {
  return renderToStaticMarkup(
    <OutlineTree
      headings={headings}
      folded={new Set(folded)}
      line={line}
      onJump={() => {}}
      onToggle={() => {}}
      onLeave={() => {}}
    />,
  )
}

const current = (markup: string) =>
  [
    ...markup.matchAll(
      /aria-current="location"[^>]*>(?:<span[^>]*>.*?<\/span>)*?<span class="outline-label">([^<]*)/g,
    ),
  ].map((m) => m[1])

describe('the outline tree', () => {
  it('marks the heading that holds the line', () => {
    expect(current(html(1))).toEqual(['One'])
    expect(current(html(3))).toEqual(['Deep'])
    expect(current(html(4))).toEqual(['Beta'])
    expect(current(html(5))).toEqual(['Two'])
  })

  it('marks nothing above the first heading', () => {
    const markup = renderToStaticMarkup(
      <OutlineTree
        headings={outlineHeadings('text\n# H')}
        folded={new Set()}
        line={1}
        onJump={() => {}}
        onToggle={() => {}}
        onLeave={() => {}}
      />,
    )
    expect(markup).not.toContain('aria-current')
  })

  it('shows a folded heading as current for what is folded under it, and hides those', () => {
    const markup = html(3, [headings[1]!.key])
    expect(markup).not.toContain('>Deep<')
    expect(current(markup)).toEqual(['Alpha'])
    expect(markup).toContain('aria-expanded="false"')
  })

  it('has one tab stop, on the current heading', () => {
    expect(html(4).match(/tabindex="0"/g)).toHaveLength(1)
    expect(html(4)).toMatch(
      /aria-current="location"[^>]*tabindex="0"|tabindex="0"[^>]*aria-current="location"/,
    )
  })

  it('says so when the note has no headings', () => {
    const markup = renderToStaticMarkup(
      <OutlineTree
        headings={[]}
        folded={new Set()}
        line={1}
        onJump={() => {}}
        onToggle={() => {}}
        onLeave={() => {}}
      />,
    )
    expect(markup).toContain('No headings')
  })
})

describe('the line store', () => {
  it('tells its listeners only when the line changes', () => {
    const store = lineStore()
    const seen = vi.fn<() => void>()
    store.subscribe(seen)
    store.set(1)
    store.set(4)
    store.set(4)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(store.get()).toBe(4)
  })
})
