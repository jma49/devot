import { describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '../../../core'
import { appHandlers, type AppCommandActions, type AppCommandState } from './appHandlers'

vi.mock('../licence', () => ({ editingAllowed: () => true }))

const note = (id: string, extra: Partial<NoteSummary> = {}): NoteSummary =>
  ({ id, title: id, bookId: null, pinned: false, tagIds: [], ...extra }) as NoteSummary

const state = (extra: Partial<AppCommandState> = {}): AppCommandState => ({
  coreReady: true,
  query: '',
  sidebarShown: true,
  syncScroll: true,
  historyBarShown: false,
  outlineShown: false,
  authorshipShown: false,
  listDates: 'relative',
  mirrorOn: false,
  inWorkspace: false,
  updateReady: false,
  focus: false,
  inTrash: false,
  inTemplates: false,
  trash: [],
  selected: undefined,
  multiIds: undefined,
  selectedNotes: [],
  listedIds: [],
  listedSet: new Set(),
  shownSelection: undefined,
  canBoard: false,
  boardShown: false,
  canGallery: false,
  galleryShown: false,
  canGoBack: false,
  canGoForward: false,
  hasNext: false,
  hasPrevious: false,
  builtIn: undefined,
  openNote: undefined,
  selectedIsTemplate: false,
  tree: [],
  mode: 'edit',
  palette: { open: false, inTable: false, selection: false, link: false, image: null },
  findCommands: {},
  ...extra,
})

const actions = (): AppCommandActions => {
  const known: Record<string, unknown> = {}
  return new Proxy(known, {
    get: (_, name: string) => (known[name] ??= vi.fn<(...args: unknown[]) => void>()),
  }) as unknown as AppCommandActions
}

describe('appHandlers', () => {
  it('offers Save Search only for a typed query once the core runs', () => {
    expect(appHandlers(state(), actions())['search.save']).toBeUndefined()
    expect(appHandlers(state({ query: ' a ' }), actions())['search.save']).toBeDefined()
    expect(
      appHandlers(state({ query: 'a', coreReady: false }), actions())['search.save'],
    ).toBeUndefined()
  })

  it('names the sidebar command after what it will do', () => {
    expect(appHandlers(state(), actions())['view.sidebar']?.label).toBe('command.hideSidebar')
    expect(appHandlers(state({ sidebarShown: false }), actions())['view.sidebar']?.label).toBe(
      'command.showSidebar',
    )
  })

  it('runs the batch commands on every selected note', async () => {
    const act = actions()
    const handlers = appHandlers(
      state({ multiIds: ['a', 'b'], selectedNotes: [note('a', { pinned: true }), note('b')] }),
      act,
    )
    expect(handlers['note.pin']?.label).toBe('batch.pin')
    expect(handlers['note.removeTag']).toBeUndefined()
    await handlers['note.moveAnywhere']?.run()
    expect(act.runOn).toHaveBeenCalledWith('move', ['a', 'b'])
  })

  it('restores or deletes a selection in the Trash instead of moving it', async () => {
    const act = actions()
    const handlers = appHandlers(state({ inTrash: true, multiIds: ['a'] }), act)
    expect(handlers['note.move']).toBeUndefined()
    await handlers['trash.restore']?.run()
    expect(act.restoreNotes).toHaveBeenCalledWith(['a'])
  })

  it('gives the open note its commands, without the editor ones in Preview', async () => {
    const act = actions()
    const open = state({ openNote: note('n'), selected: 'n' })
    const handlers = appHandlers(open, act)
    expect(handlers['note.pin']?.label).toBe('note.pin')
    expect(handlers['edit.pastePlain']).toBeDefined()
    expect(handlers['note.quickTag']).toBeDefined()
    await handlers['note.close']?.run()
    expect(act.closeNote).toHaveBeenCalled()
    expect(appHandlers({ ...open, mode: 'preview' }, act)['edit.pastePlain']).toBeUndefined()
  })

  it('opens All Notes before making a note from the Trash', async () => {
    const act = actions()
    await appHandlers(state({ inTrash: true }), act)['note.new']?.run()
    expect(act.showLibrary).toHaveBeenCalledWith({ kind: 'all' })
    expect(act.create).toHaveBeenCalled()
  })

  it('steps board cards for the open listed note', async () => {
    const act = actions()
    const handlers = appHandlers(
      state({ boardShown: true, selected: 'a', listedSet: new Set(['a']) }),
      act,
    )
    await handlers['status.next']?.run()
    expect(act.stepCards).toHaveBeenCalledWith(['a'], 1)
  })

  it('lets Find commands replace the window ones', () => {
    const find = { run: () => {} }
    expect(
      appHandlers(state({ findCommands: { 'palette.open': find } }), actions())['palette.open'],
    ).toBe(find)
  })

  it('offers Note Info for one note open, in the Trash too, but not for a template', () => {
    const one = note('a')
    expect(appHandlers(state(), actions())['view.noteInfo']).toBeUndefined()
    expect(appHandlers(state({ openNote: one }), actions())['view.noteInfo']).toBeDefined()
    expect(
      appHandlers(state({ openNote: one, selectedIsTemplate: true }), actions())['view.noteInfo'],
    ).toBeUndefined()
    expect(
      appHandlers(state({ inTrash: true, selected: 'a' }), actions())['view.noteInfo'],
    ).toBeDefined()
    expect(
      appHandlers(state({ inTrash: true, selected: 'a', multiIds: ['a', 'b'] }), actions())[
        'view.noteInfo'
      ],
    ).toBeUndefined()
  })
})
