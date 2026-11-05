// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLI_APPEND_EVENT } from './cliAppend'
import type { Core } from './core-client'
import { useCliAppend, useHttpApi, useQuickCapture } from './hostCalls'
import { HTTP_API_EVENT } from './httpApiHost'
import { QUICK_CAPTURE_EVENT } from './quickCaptureHost'
import { renderHook, settle, unmountAll } from '../../../tests/support/render-hook'
import { mockTauri } from '../../../tests/support/tauri-events'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', false))

let tauri: ReturnType<typeof mockTauri>
afterEach(() => {
  unmountAll()
  tauri.clear()
})

const core = {} as Core
const refresh = async () => {}
const answer = (cmd: string) => (cmd === 'cli_append_take' ? [] : null)

const hosts = () => {
  useQuickCapture(core, refresh)
  useHttpApi(core)
  useCliAppend(
    core,
    refresh,
    () => {},
    () => ({}) as never,
  )
}
const EVENTS = [QUICK_CAPTURE_EVENT, HTTP_API_EVENT, CLI_APPEND_EVENT]

describe('host calls', () => {
  it('stops the listeners that register after the window unmounted, and asks Rust for nothing', async () => {
    tauri = mockTauri(answer)
    tauri.hold()
    const hook = renderHook(hosts, { props: undefined })
    await settle()
    hook.unmount()
    tauri.release()
    await settle()
    for (const event of EVENTS) expect(tauri.listening(event)).toBe(0)
    expect(tauri.invoked).toEqual([])
  })

  it('keeps one listener each under StrictMode and says so to Rust once', async () => {
    tauri = mockTauri(answer)
    tauri.hold()
    renderHook(hosts, { props: undefined, strict: true })
    await settle()
    tauri.release()
    await settle()
    for (const event of EVENTS) expect(tauri.listening(event)).toBe(1)
    expect(tauri.invoked.toSorted()).toEqual(['cli_append_take', 'http_api_listening'])
  })

  it('takes the waiting devot append requests only once it listens for new ones', async () => {
    tauri = mockTauri(answer)
    tauri.hold()
    renderHook(hosts, { props: undefined })
    await settle()
    expect(tauri.invoked).not.toContain('cli_append_take')
    tauri.release()
    await settle()
    expect(tauri.listening(CLI_APPEND_EVENT)).toBe(1)
    expect(tauri.invoked).toContain('cli_append_take')
  })
})
