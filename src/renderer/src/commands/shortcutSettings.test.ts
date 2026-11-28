// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settle } from '../../../../tests/support/render-hook'
import { mockTauri } from '../../../../tests/support/tauri-events'
import { invoke } from '../ipc'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', false))

vi.mock('../ipc', () => ({
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    revision: 1,
    overrides: { 'app.backups': ['Mod+Alt+B'] },
  })),
}))

let tauri: ReturnType<typeof mockTauri>
afterEach(() => tauri?.clear())

describe('startShortcutSettings', () => {
  it('subscribes to devot://keyboard-shortcuts-changed before reading keyboard_shortcuts_get', async () => {
    tauri = mockTauri()
    tauri.hold()
    const { currentKeymap, startShortcutSettings } = await import('./shortcutSettings')
    startShortcutSettings()
    await settle()
    expect(invoke).not.toHaveBeenCalled()
    tauri.release()
    await settle()
    expect(invoke).toHaveBeenCalledWith('keyboard_shortcuts_get')
    expect(currentKeymap().get('app.backups')).toEqual(['Mod+Alt+B'])
    tauri.emit('devot://keyboard-shortcuts-changed', {
      revision: 2,
      overrides: { 'app.backups': ['Mod+Shift+B'] },
    })
    expect(currentKeymap().get('app.backups')).toEqual(['Mod+Shift+B'])
  })
})
