import { describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '../../../core'
import { paletteActions, type PaletteContext } from './appActions'
import type { PaletteEntry } from './results'

const note = (id: string, extra: Partial<NoteSummary> = {}): NoteSummary =>
  ({ id, title: id, bookId: 'b1', pinned: false, tagIds: [], ...extra }) as NoteSummary

const context = (extra: Partial<PaletteContext> = {}): PaletteContext => ({
  commands: {},
  editing: true,
  openNote: undefined,
  selectedIsTemplate: false,
  selected: undefined,
  inTrash: false,
  query: '',
  runPlugin: vi.fn<PaletteContext['runPlugin']>(),
  showLibrary: vi.fn<PaletteContext['showLibrary']>(),
  openWorkspace: vi.fn<PaletteContext['openWorkspace']>(),
  moveNote: vi.fn<PaletteContext['moveNote']>(),
  showFilter: vi.fn<PaletteContext['showFilter']>(),
  changeQuery: vi.fn<PaletteContext['changeQuery']>(),
  putTagOnNotes: vi.fn<PaletteContext['putTagOnNotes']>(),
  editor: () => null,
  select: vi.fn<PaletteContext['select']>(),
  ...extra,
})

const entry = (kind: PaletteEntry['kind'], id: string, label = id): PaletteEntry => ({
  kind,
  id,
  label,
})

describe('paletteActions', () => {
  it('runs a command through the handler the window has for it', async () => {
    const run = vi.fn<() => void>()
    await paletteActions(
      entry('command', 'note.new'),
      context({ commands: { 'note.new': { run } } }),
    ).primary.run()
    expect(run).toHaveBeenCalled()
  })

  it('runs a plugin command as the plugin action its entry names', async () => {
    const at = context()
    await paletteActions(entry('command', 'plugin:command:p/go'), at).primary.run()
    expect(at.runPlugin).toHaveBeenCalledWith({ kind: 'command', plugin: 'p', id: 'go' })
  })

  it('offers to move the open note into another notebook only', () => {
    const open = context({ openNote: note('n') })
    expect(paletteActions(entry('book', 'b1'), open).shift).toBeUndefined()
    expect(paletteActions(entry('book', 'b2'), open).shift).toBeDefined()
    expect(paletteActions(entry('book', 'b2'), { ...open, editing: false }).shift).toBeUndefined()
  })

  it('offers to tag the open note only with a tag it lacks, and never a template', () => {
    const open = context({ openNote: note('n', { tagIds: ['t1'] }) })
    expect(paletteActions(entry('tag', 't1'), open).shift).toBeUndefined()
    expect(paletteActions(entry('tag', 't2'), open).shift).toBeDefined()
    expect(
      paletteActions(entry('tag', 't2'), { ...open, selectedIsTemplate: true }).shift,
    ).toBeUndefined()
  })

  it('leaves the Trash to open a note, and leaves an open note as it is', async () => {
    const trash = context({ inTrash: true })
    await paletteActions(entry('note', 'n'), trash).primary.run()
    expect(trash.showLibrary).toHaveBeenCalledWith({ kind: 'all' })
    expect(trash.select).toHaveBeenCalledWith('n')
    const open = context({ selected: 'n' })
    await paletteActions(entry('note', 'n'), open).primary.run()
    expect(open.select).not.toHaveBeenCalled()
  })
})
