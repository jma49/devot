import { beforeEach, expect, it, vi } from 'vitest'
import { loadHttpApi, saveHttpApi } from '../../src/renderer/src/settings/httpApi'

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}))
vi.mock('../../src/renderer/src/ipc', () => ({ invoke }))

const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const view = {
  enabled: false,
  port: 27484,
  scope: 'read',
  extensionOrigins: [],
  listening: null,
  problem: null,
  token: 'unset',
}

beforeEach(() => {
  invoke.mockReset()
})

it('loads an empty registration list and saves it with the enabled and port choices', async () => {
  invoke.mockResolvedValue(view)
  expect((await loadHttpApi()).extensionOrigins).toEqual([])
  invoke.mockResolvedValue({ ...view, extensionOrigins: [origin] })
  expect((await saveHttpApi(false, 27484, [origin])).extensionOrigins).toEqual([origin])
  expect(invoke).toHaveBeenLastCalledWith('http_api_set', {
    enabled: false,
    port: 27484,
    extensionOrigins: [origin],
  })
  invoke.mockResolvedValue(view)
  expect((await saveHttpApi(false, 27484, [])).extensionOrigins).toEqual([])
})

it.each([{ value: null }, { value: 'not a list' }, { value: [3] }])(
  'refuses a malformed registered-origin view: $value',
  async ({ value: extensionOrigins }) => {
    invoke.mockResolvedValue({ ...view, extensionOrigins })
    await expect(loadHttpApi()).rejects.toThrow('E_HTTP_API_VIEW_INVALID')
  },
)

it('preserves a Rust validation error', async () => {
  invoke.mockRejectedValue(new Error('E_HTTP_API_ORIGINS_INVALID'))
  await expect(saveHttpApi(false, 27484, ['null'])).rejects.toThrow('E_HTTP_API_ORIGINS_INVALID')
})
