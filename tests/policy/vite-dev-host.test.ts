import { afterEach, expect, it, vi } from 'vitest'

async function devHost(): Promise<unknown> {
  vi.resetModules()
  const { default: config } = await import('../../vite.config')
  return (config as { server?: { host?: unknown } }).server?.host
}

afterEach(() => {
  vi.unstubAllEnvs()
})

it('the dev server stays on localhost for the desktop app', async () => {
  vi.stubEnv('TAURI_DEV_HOST', '')
  expect(await devHost()).toBe(false)
})

it('the dev server listens on the address tauri ios dev gives a phone', async () => {
  vi.stubEnv('TAURI_DEV_HOST', '192.0.2.10')
  expect(await devHost()).toBe('192.0.2.10')
})
