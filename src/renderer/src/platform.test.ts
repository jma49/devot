import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<undefined>>(() => Promise.resolve(undefined)),
)
vi.mock('./ipc', () => ({ invoke }))

beforeEach(() => {
  invoke.mockClear()
  vi.stubGlobal('window', { addEventListener: vi.fn<() => void>() })
  vi.stubGlobal('DEVOT_UI_TEST', true)
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it('a phone asks Rust for no update status, which it does not register', async () => {
  vi.stubEnv('TAURI_ENV_PLATFORM', 'ios')
  const { startUpdateStatus, checkForUpdates } = await import('./updates')
  startUpdateStatus()
  await checkForUpdates()
  expect(invoke).not.toHaveBeenCalled()
})

it('the Mac still asks for its update status', async () => {
  vi.stubEnv('TAURI_ENV_PLATFORM', 'darwin')
  const { startUpdateStatus } = await import('./updates')
  startUpdateStatus()
  expect(invoke).toHaveBeenCalledWith('update_status')
})

it('a phone makes no native menu call, having no menu', async () => {
  vi.stubEnv('TAURI_ENV_PLATFORM', 'ios')
  const { queueMenuCall } = await import('./commands/commandMenu')
  const call = vi.fn<() => Promise<string>>(() => Promise.resolve('set'))
  await queueMenuCall(call)
  expect(call).not.toHaveBeenCalled()
})

it('the Mac makes its native menu calls', async () => {
  vi.stubEnv('TAURI_ENV_PLATFORM', 'darwin')
  const { queueMenuCall } = await import('./commands/commandMenu')
  const call = vi.fn<() => Promise<string>>(() => Promise.resolve('set'))
  await queueMenuCall(call)
  expect(call).toHaveBeenCalledOnce()
})
