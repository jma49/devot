import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ImportScan } from '../../core'
import type { BookNode } from '../../core/books'
import { ImportDialog, type ImportJob } from './ImportDialog'

vi.mock('./icons/Icon', () => ({ Icon: () => null }))
// The scan's live counts come from the window; these tests look at the steps.
vi.mock('./importProgress', () => ({ useScanFound: () => ({ files: 0, images: 0 }) }))

const BOOK = '01890a5d-ac96-774b-bcce-b302099a8057'
const tree: BookNode[] = [
  {
    id: BOOK,
    name: 'Inbox',
    parentId: null,
    depth: 0,
    aiAccess: false,
    icon: null,
    iconColor: null,
    children: [],
  },
]

const scan = (kind: ImportScan['kind'], destination?: string | null): ImportScan => ({
  id: 3,
  name: 'Vault',
  kind,
  files: [{ path: kind === 'files' ? 'a.md' : 'Vault/a.md', bytes: 10 }],
  images: [],
  skipped: [],
  ...(destination === undefined ? {} : { destination }),
})

const render = (s: ImportScan) => {
  const job: ImportJob = { id: s.id, name: s.name, kind: s.kind, scan: s, failed: null }
  return renderToStaticMarkup(
    <ImportDialog
      job={job}
      tree={tree}
      initialDestination={null}
      onImport={() => new Promise(() => {})}
      onClose={() => {}}
    />,
  )
}

describe('ImportDialog with a notebook preset', () => {
  it('offers Import into that notebook from a folder tree, with no notebook to choose', () => {
    const html = render(scan('folder', BOOK))
    expect(html).toContain('Import into “Inbox”')
    expect(html).not.toContain('>Continue<')
  })

  it('imports picked files at once, with no notebook list', () => {
    const html = render(scan('files', BOOK))
    expect(html).toContain('import-progress')
    expect(html).not.toContain('role="listbox"')
  })

  it('falls back to choosing a notebook when the preset one has gone', () => {
    const gone = '01890a5d-ac96-774b-bcce-b302099a8058'
    expect(render(scan('folder', gone))).toContain('>Continue<')
    expect(render(scan('files', gone))).toContain('role="listbox"')
  })

  it('asks for a notebook without a preset, as from File > Import', () => {
    expect(render(scan('folder', null))).toContain('>Continue<')
    expect(render(scan('files'))).toContain('role="listbox"')
  })
})

describe('ImportDialog folder list', () => {
  it('is a plain nested list a screen reader can walk, not an unfocusable tree', () => {
    const html = render(scan('folder', null))
    expect(html).toContain('class="import-tree"')
    expect(html).not.toMatch(/role="(tree|treeitem|group)"/)
    expect(html).not.toContain('aria-selected')
  })

  // WebKit drops list semantics from a list styled without markers unless the role is explicit.
  it('keeps list roles on every level so VoiceOver reads its depth', () => {
    const nested = { ...scan('folder', null), files: [{ path: 'Vault/Sub/a.md', bytes: 10 }] }
    const html = render(nested)
    const lists = html.match(/<ul [^>]*class="import-tree(-group)?"[^>]*>/g) ?? []
    expect(lists.length).toBeGreaterThan(1)
    for (const list of lists) expect(list).toContain('role="list"')
  })
})
