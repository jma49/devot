// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { licenceSnapshot, startLicence } from './licence'
import { settle } from '../../../tests/support/render-hook'
import { mockTauri } from '../../../tests/support/tauri-events'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', false))

const CHANGED = 'devot://licence-changed'
const state = (licensee: string) => ({
  gated: false,
  state: 'valid',
  code: null,
  id: '5vEvzHainWD0cA2Ht_ljHg',
  licensee,
  plan: 'pro',
})

let tauri: ReturnType<typeof mockTauri>
afterEach(() => tauri.clear())

it('keeps a change Rust announced while the window was still starting to listen', async () => {
  let stored = state('first@example.com')
  tauri = mockTauri((cmd) => (cmd === 'licence_get' ? stored : null))
  tauri.hold()
  startLicence()
  await settle()
  stored = state('second@example.com')
  tauri.emit(CHANGED, stored)
  tauri.release()
  await settle()
  expect(licenceSnapshot().licensee).toBe('second@example.com')
})
