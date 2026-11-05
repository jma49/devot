// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Core } from './core-client'
import { IMPORT_SCANNING } from './importer'
import { useSheets } from './sheets'
import { renderHook, settle, unmountAll } from '../../../tests/support/render-hook'
import { mockTauri } from '../../../tests/support/tauri-events'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', false))

const EVENTS = [
  'devot://show-backups',
  'devot://backup-failed',
  'devot://import-scanning',
  'devot://import-progress',
  'devot://import-ready',
  'devot://import-failed',
]

let tauri: ReturnType<typeof mockTauri>
afterEach(() => {
  unmountAll()
  tauri.clear()
})

const answer = (cmd: string) => (cmd === 'backups_list' ? { lastError: null } : null)

function props() {
  const core = {} as Core
  return {
    core,
    coreRef: { current: core as Core | undefined },
    refresh: vi.fn<(c: Core) => Promise<unknown>>(async () => {}),
    showLibraryRef: { current: undefined },
  }
}

const scanning = (id: number) =>
  window.dispatchEvent(
    new CustomEvent(IMPORT_SCANNING, { detail: { id, name: `folder ${id}`, kind: 'folder' } }),
  )

describe('useSheets', () => {
  it('stops the listeners that register after the window unmounted', async () => {
    tauri = mockTauri(answer)
    tauri.hold()
    const hook = renderHook(useSheets, { props: props() })
    await settle()
    hook.unmount()
    tauri.release()
    await settle()
    for (const event of EVENTS) expect(tauri.listening(event)).toBe(0)
  })

  it('keeps one listener for each event under StrictMode', async () => {
    tauri = mockTauri(answer)
    tauri.hold()
    renderHook(useSheets, { props: props(), strict: true })
    await settle()
    tauri.release()
    await settle()
    for (const event of EVENTS) expect(tauri.listening(event)).toBe(1)
  })

  it('shows imports one at a time, and Backups after them', async () => {
    tauri = mockTauri(answer)
    const hook = renderHook(useSheets, { props: props() })
    await settle()
    act(() => {
      scanning(1)
      scanning(2)
      hook.current.showBackups()
    })
    expect(hook.current.importJob?.id).toBe(1)
    act(() => hook.current.closeImport(false))
    expect(hook.current.importJob?.id).toBe(2)
    expect(hook.current.backupsOpen).toBe(false)
    act(() => hook.current.closeImport(false))
    expect(hook.current.importJob).toBeUndefined()
    expect(hook.current.backupsOpen).toBe(true)
  })

  it('holds an import back while Backups is open', async () => {
    tauri = mockTauri(answer)
    const hook = renderHook(useSheets, { props: props() })
    await settle()
    act(() => hook.current.showBackups())
    act(() => scanning(1))
    expect(hook.current.importJob).toBeUndefined()
    act(() => hook.current.closeBackups())
    expect(hook.current.importJob?.id).toBe(1)
  })
})
