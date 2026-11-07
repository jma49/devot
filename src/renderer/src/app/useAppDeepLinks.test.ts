// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary, TrashedNote } from '../../../core'
import type { Core } from '../core-client'
import type { useLicenceLink } from '../LicenceLink'
import type { Selection } from '../Sidebar'
import { renderHook, settle, unmountAll } from '../../../../tests/support/render-hook'
import { mockTauri } from '../../../../tests/support/tauri-events'
import { useAppDeepLinks } from './useAppDeepLinks'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', false))

const LISTED = '01890a5d-ac96-774b-bcce-b302099a8057'
const UNLISTED = '01890a5d-ac96-774b-bcce-b302099a8058'
const TRASHED = '01890a5d-ac96-774b-bcce-b302099a8059'
const ELSEWHERE = '01890a5d-ac96-774b-bcce-b302099a805a'

const note = (id: string): NoteSummary => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt: 1,
  bodyVersion: 0,
  bookId: null,
  status: 'none',
  pinned: false,
  tagIds: [],
})

let tauri: ReturnType<typeof mockTauri>
afterEach(() => {
  unmountAll()
  tauri.clear()
})

function links(ready: boolean, launched: unknown[] = []) {
  tauri = mockTauri((cmd) => (cmd === 'deep_link_take' ? launched : null))
  const select = vi.fn<(id: string) => Promise<boolean>>(async () => true)
  const showLibrary = vi.fn<(next: Selection, options?: { clearFilter?: boolean }) => void>()
  const openTrashed = vi.fn<(id: string) => void>()
  const core = {
    title: async (id: string) => {
      if (id !== ELSEWHERE) throw new Error('E_NOTE_NOT_FOUND')
      return 'Made elsewhere'
    },
  } as unknown as Core
  const props = (shown: boolean) => ({
    ready: shown,
    core,
    coreRef: { current: core },
    editing: true,
    commands: {},
    licenceLink: { handle: () => {} } as unknown as ReturnType<typeof useLicenceLink>,
    startImport: async () => null,
    showLibrary,
    showLibraryRef: { current: showLibrary },
    select,
    openTrashed,
    listedSet: new Set([LISTED]),
    notes: [note(LISTED), note(UNLISTED)],
    templates: [],
    trash: [{ id: TRASHED } as TrashedNote],
    inTrash: false,
  })
  const hook = renderHook(({ shown }: { shown: boolean }) => useAppDeepLinks(props(shown)), {
    props: { shown: ready },
  })
  return { hook, select, showLibrary, openTrashed, show: () => hook.rerender({ shown: true }) }
}

describe('useAppDeepLinks', () => {
  it('opens the note a launch came with once the window has restored, not before', async () => {
    const { select, show } = links(false, [{ kind: 'note', id: LISTED }])
    await settle()
    expect(select).not.toHaveBeenCalled()
    show()
    await settle()
    expect(select).toHaveBeenCalledExactlyOnceWith(LISTED)
  })

  it('shows every note for a note the view does not list', async () => {
    const { select, showLibrary } = links(true)
    await settle()
    tauri.emit('devot://open-url', { kind: 'note', id: UNLISTED })
    await settle()
    expect(showLibrary).toHaveBeenCalledWith({ kind: 'all' }, { clearFilter: true })
    expect(select).toHaveBeenCalledWith(UNLISTED)
  })

  it('opens a trashed note in the Trash', async () => {
    const { select, showLibrary, openTrashed } = links(true)
    await settle()
    tauri.emit('devot://open-url', { kind: 'note', id: TRASHED })
    await settle()
    expect(showLibrary).toHaveBeenCalledWith({ kind: 'trash' })
    expect(openTrashed).toHaveBeenCalledWith(TRASHED)
    expect(select).not.toHaveBeenCalled()
  })

  it('asks the core about a note not in the lists yet', async () => {
    const { select } = links(true)
    await settle()
    tauri.emit('devot://open-url', { kind: 'note', id: ELSEWHERE })
    await settle()
    await settle()
    expect(select).toHaveBeenCalledWith(ELSEWHERE)
  })
})
