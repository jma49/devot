import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { BookNode } from '../../core/books'
import type { TagRecord } from '../../core/storage'
import { Sidebar } from './Sidebar'
import { sectionStore, type SectionStore } from './sidebarSections'

// Icons and the footer read the window (symbols, the mirror and backups); the
// sections are what these tests look at.
vi.mock('./icons/Icon', () => ({ Icon: () => null, SymbolIcon: () => null }))
vi.mock('./SidebarFooter', () => ({ SidebarFooter: () => null }))
vi.mock('./commands/shortcutSettings', () => ({ useKeymap: () => ({}) }))

const memory = () => {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

const book: BookNode = {
  id: 'b1',
  name: 'Inbox',
  parentId: null,
  depth: 0,
  aiAccess: false,
  icon: null,
  iconColor: null,
  children: [],
}

const tag = (id: string, name: string): TagRecord => ({
  id,
  name,
  nameHlc: '1',
  color: null,
  colorHlc: '',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  deletedHlc: null,
})

const noop = () => undefined

function render(
  store: SectionStore,
  tree: BookNode[] = [book],
  more: Partial<ComponentProps<typeof Sidebar>> = {},
) {
  return renderToStaticMarkup(
    <Sidebar
      total={4}
      tree={tree}
      counts={new Map([['b1', 1]])}
      selection={{ kind: 'all' }}
      renaming={undefined}
      onSelect={noop}
      onCreateBook={noop}
      onRenameBook={noop}
      onRenameDone={noop}
      onMoveBook={noop}
      onPlaceBook={noop}
      onSetAiAccess={noop}
      onSetBookIcon={noop}
      onDeleteBook={noop}
      onExportBook={noop}
      onImportBook={noop}
      onMoveNotes={noop}
      filter={null}
      onFilter={noop}
      pinnedCount={0}
      statusCounts={new Map()}
      tags={[tag('t1', 'Tutorial')]}
      tagCounts={new Map([['t1', 2]])}
      onRenameTag={noop}
      onSetTagColor={noop}
      onDeleteTag={noop}
      templatesCount={0}
      trashCount={0}
      onHide={noop}
      onSearchBooks={noop}
      onSearchTags={noop}
      onEmptyTrash={noop}
      sectionStore={store}
      {...more}
    />,
  )
}

/** Where each text first shows in the markup. */
const order = (html: string, texts: string[]) =>
  texts.map((text) => [text, html.indexOf(`>${text}<`)] as const)

describe('Sidebar sections', () => {
  it('render in the order: All Notes, Pinned, Templates, Notebooks, Status, Tags, Trash', () => {
    const html = render(sectionStore(memory(), 'main'))
    const found = order(html, [
      'All Notes',
      'Pinned',
      'Templates',
      'Notebooks',
      'Status',
      'Tags',
      'Trash',
    ])
    expect(found.every(([, at]) => at >= 0)).toBe(true)
    const positions = found.map(([, at]) => at)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('hides the rows of a collapsed Tags section, and a fresh sidebar remembers it', () => {
    const storage = memory()
    expect(render(sectionStore(storage, 'main'))).toContain('Tutorial')
    sectionStore(storage, 'main').save(new Set(['tags']))
    // A new mount reads the stored choice.
    const collapsed = render(sectionStore(storage, 'main'))
    expect(collapsed).not.toContain('Tutorial')
    expect(collapsed).toContain('aria-label="Expand Tags"')
    // The other sections stay open.
    expect(collapsed).toContain('Active')
  })

  it('keeps a folded notebook shut after a restart', () => {
    const child: BookNode = {
      ...book,
      id: 'b2',
      name: 'Receipts',
      parentId: 'b1',
      depth: 1,
    }
    const parent: BookNode = { ...book, children: [child] }
    const storage = memory()
    expect(render(sectionStore(storage, 'main'), [parent])).toContain('Receipts')
    sectionStore(storage, 'main').saveBooks(new Set(['b1']))
    const folded = render(sectionStore(storage, 'main'), [parent])
    expect(folded).not.toContain('Receipts')
    expect(folded).toContain('aria-expanded="false"')
  })

  it('turns one chevron: down while a section is open, up while it is folded', () => {
    const storage = memory()
    const open = render(sectionStore(storage, 'main'))
    expect(open).toMatch(/aria-label="Collapse Tags"[^>]*><span class="chevron"><\/span>/)
    sectionStore(storage, 'main').save(new Set(['tags']))
    const folded = render(sectionStore(storage, 'main'))
    expect(folded).toMatch(
      /aria-label="Expand Tags"[^>]*><span class="chevron" data-turn="up"><\/span>/,
    )
  })

  it('shows a chevron on Status and Tags, a search on Notebooks and Tags', () => {
    const html = render(sectionStore(memory(), 'main'))
    expect(html).toContain('aria-label="Collapse Status"')
    expect(html).toContain('aria-label="Collapse Tags"')
    expect(html).toContain('aria-label="Search Notebooks"')
    expect(html).toContain('aria-label="Search Tags"')
    expect(html).toContain('aria-label="New Notebook"')
  })
})

describe('Sidebar in a workspace', () => {
  const top: BookNode = { ...book, id: 'w0', name: 'Work' }
  const space: BookNode = { ...book, id: 'w1', name: 'Projects', parentId: 'w0', depth: 1 }
  const sub: BookNode = { ...book, id: 'w2', name: 'Plans', parentId: 'w1', depth: 0 }
  const inWorkspace = () =>
    render(sectionStore(memory(), 'main'), [sub], {
      total: 3,
      selection: { kind: 'book', id: 'w1' },
      statusCounts: new Map([['active', 2]]),
      workspace: { book: space, parents: [top], library: [{ ...top, children: [space] }] },
    })

  it('shows its title with the notebooks above it, and a way back up', () => {
    const html = inWorkspace()
    expect(html).toContain('aria-label="Workspace Projects"')
    expect(html).toContain('>Projects<')
    expect(html).toContain('aria-label="Open Work as Workspace"')
    expect(html).toContain('aria-label="Go Up a Level"')
  })

  it('shows All Notes, its sub-notebooks, Status and Tags, and no Pinned, Templates or Trash', () => {
    const html = inWorkspace()
    const found = order(html, ['Projects', 'All Notes', 'Notebooks', 'Plans', 'Status', 'Tags'])
    expect(found.every(([, at]) => at >= 0)).toBe(true)
    const positions = found.map(([, at]) => at)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    for (const hidden of ['Pinned', 'Templates', 'Trash', 'Inbox']) {
      expect(html).not.toContain(`>${hidden}<`)
    }
  })

  it('counts the workspace: All Notes is its notebook, shown as current', () => {
    const html = inWorkspace()
    expect(html).toMatch(/data-sidebar-row="book:w1"[^>]*aria-current="true"/)
    expect(html).toMatch(/All Notes<\/span><span class="source-count">3</)
    expect(html).toMatch(/Active<\/span><span class="source-count">2</)
  })

  it('shows no title outside a workspace', () => {
    const html = render(sectionStore(memory(), 'main'))
    expect(html).not.toContain('sidebar-workspace')
    expect(html).toContain('data-sidebar-row="all"')
  })
})
