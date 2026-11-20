// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Core } from './core-client'
import { IMPORT_SCANNING } from './importer'
import { backupsTransition, useSheets } from './sheets'
import { droppedImport } from './dropImport'
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
  it('names the queued, visible and restoring Backups transitions', () => {
    tauri = mockTauri(answer)
    const waiting = backupsTransition({ phase: 'closed' }, 'request')
    expect(waiting).toEqual({ phase: 'waiting' })
    const open = backupsTransition(waiting, 'show')
    expect(open).toEqual({ phase: 'open' })
    expect(backupsTransition(open, 'request')).toBe(open)
    const restoring = backupsTransition(open, 'restore')
    expect(restoring).toEqual({ phase: 'restoring' })
    expect(backupsTransition(restoring, 'close')).toBe(restoring)
    expect(backupsTransition(restoring, 'request')).toBe(restoring)
    const failed = backupsTransition(restoring, 'failed')
    expect(failed).toEqual({ phase: 'open' })
    expect(backupsTransition(failed, 'close')).toEqual({ phase: 'closed' })
    expect(backupsTransition(waiting, 'close')).toEqual({ phase: 'closed' })
    expect(backupsTransition({ phase: 'closed' }, 'show')).toEqual({ phase: 'closed' })
  })
  it('refuses drops during Backups and waits for an in-flight conversion before restore', async () => {
    tauri = mockTauri((cmd) => {
      if (cmd === 'backup_restore') throw new Error('E_RESTORE_TEST')
      return answer(cmd)
    })
    const given = props()
    const stopImport = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    Object.assign(given.core, {
      stopImport,
      flush: async () => {},
      holdCompaction: async () => {},
      resumeCompaction: async () => {},
    })
    const hook = renderHook(useSheets, { props: given })
    await settle()
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const active = hook.current.runDrop(() => held)
    act(() => hook.current.showBackups())
    const refused = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    expect(await hook.current.runDrop(refused)).toBe(false)
    const restoring = hook.current.restore('backup').then(
      () => 'restored',
      () => 'failed',
    )
    await settle()
    act(() => hook.current.closeBackups())
    expect(hook.current.dropsAllowed()).toBe(false)
    expect(stopImport).not.toHaveBeenCalled()
    expect(tauri.invoked).not.toContain('backup_restore')
    release()
    expect(await active).toBe(true)
    await expect(restoring).resolves.toBe('failed')
    expect(tauri.invoked).toContain('backup_restore')
    expect(refused).not.toHaveBeenCalled()
    act(() => hook.current.closeBackups())
    expect(await hook.current.runDrop(async () => {})).toBe(true)
    await expect(
      hook.current.runDrop(async () => {
        throw new Error('E_DROP_TEST')
      }),
    ).rejects.toThrow('E_DROP_TEST')
    expect(await hook.current.runDrop(async () => {})).toBe(true)
  })
  it('queues dropped sources with native jobs and cleans them on cancel, close and teardown', async () => {
    tauri = mockTauri(answer)
    const hook = renderHook(useSheets, { props: props() })
    await settle()
    const first = droppedImport([new File(['note'], 'note.md')], vi.fn())
    const second = droppedImport([new File(['other'], 'other.md')], vi.fn())
    first.scan.kind = 'folder'
    second.scan.kind = 'folder'
    act(() => {
      hook.current.enqueueImport(first.scan, first)
      scanning(5)
      hook.current.enqueueImport(second.scan, second)
    })
    expect(hook.current.importJob?.id).toBe(first.scan.id)
    act(() => hook.current.closeImport(true))
    await expect(first.source.read('note.md')).rejects.toThrow('E_IMPORT_FILE_NOT_FOUND')
    expect(hook.current.importJob?.id).toBe(5)
    act(() => hook.current.closeImport(true))
    expect(hook.current.importJob?.id).toBe(second.scan.id)
    hook.unmount()
    await expect(second.source.read('other.md')).rejects.toThrow('E_IMPORT_FILE_NOT_FOUND')
    expect(tauri.calls.filter(([cmd]) => cmd === 'import_finish')).toEqual([
      ['import_finish', { id: 5 }],
    ])
  })

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
