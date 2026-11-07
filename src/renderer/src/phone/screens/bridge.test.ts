// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settle } from '../../../../../tests/support/render-hook'
import { mockTauri } from '../../../../../tests/support/tauri-events'
import { SCREENS_EVENT, startScreensBridge } from './bridge'
import { SCREENS_OPS } from './message'
import { SCREENS_HANDLERS, type ScreensHandlers } from './ops'

vi.hoisted(() => vi.stubGlobal('DEVOT_UI_TEST', false))

interface Fixture {
  readonly from: 'swift' | 'page'
  readonly code?: string
  readonly envelope?: boolean
  readonly message: unknown
}

const FIXTURES = import.meta.glob<string>('../../../../../tests/fixtures/screens/*/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const fixtures = (kind: 'valid' | 'invalid') =>
  Object.entries(FIXTURES)
    .filter(([path]) => path.includes(`/screens/${kind}/`))
    .map(
      ([path, text]) =>
        [path.slice(path.lastIndexOf('/') + 1), JSON.parse(text) as Fixture] as const,
    )

const requests = fixtures('valid').filter(([, fixture]) => fixture.from === 'swift')
const refusedRequests = fixtures('invalid').filter(
  ([, fixture]) => fixture.from === 'swift' && fixture.envelope === true,
)

let tauri: ReturnType<typeof mockTauri>
let stop = () => {}
afterEach(() => {
  stop()
  stop = () => {}
  tauri.clear()
  vi.restoreAllMocks()
})

function start(pending: readonly unknown[] = [], handlers?: ScreensHandlers, installed = true) {
  const posted: unknown[] = []
  tauri = mockTauri((cmd, args) => {
    if (cmd === 'screens_take') return { installed, pending }
    if (cmd === 'screens_post') posted.push(JSON.parse(args['message'] as string))
    return null
  })
  const bridge = startScreensBridge(handlers)
  stop = bridge.stop
  return { bridge, posted }
}

describe('the native screens bridge', () => {
  it('listens before it takes the requests that came first, and runs them in order', async () => {
    const order: number[] = []
    const { bridge, posted } = start(
      [
        { v: 1, id: 7, op: 'ping', args: {} },
        { v: 1, id: 8, op: 'ping', args: {} },
      ],
      {
        ping: async () => {
          order.push(order.length)
          return {}
        },
      },
    )
    await expect(bridge.installed).resolves.toBe(true)
    expect(tauri.listening(SCREENS_EVENT)).toBe(1)
    await settle()
    expect(posted).toStrictEqual([
      { v: 1, id: 7, ok: true, result: {} },
      { v: 1, id: 8, ok: true, result: {} },
    ])
    expect(order).toStrictEqual([0, 1])
  })

  it('answers each request with its own ID', async () => {
    let finish = (_value: unknown) => {}
    const { bridge, posted } = start([], {
      ping: () => new Promise((resolve) => (finish = resolve)),
      excerpts: async (args) => ({ count: (args['ids'] as unknown[]).length }),
    })
    await bridge.installed
    tauri.emit(SCREENS_EVENT, { v: 1, id: 3, op: 'ping', args: {} })
    tauri.emit(SCREENS_EVENT, { v: 1, id: 4, op: 'excerpts', args: { ids: ['a', 'b'] } })
    await settle()
    finish({ late: true })
    await settle()
    expect(posted).toStrictEqual([
      { v: 1, id: 4, ok: true, result: { count: 2 } },
      { v: 1, id: 3, ok: true, result: { late: true } },
    ])
  })

  it.each(requests)('takes the request %s and answers it', async (_name, fixture) => {
    const { bridge, posted } = start()
    await bridge.installed
    tauri.emit(SCREENS_EVENT, fixture.message)
    await settle()
    const { id, op } = fixture.message as { id: number; op: string }
    expect(posted).toStrictEqual([
      op === 'ping'
        ? { v: 1, id, ok: true, result: {} }
        : { v: 1, id, ok: false, code: 'E_SCREENS_OP_UNSUPPORTED' },
    ])
  })

  it.each(refusedRequests)('drops the request %s without answering', async (_name, fixture) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { bridge, posted } = start()
    await bridge.installed
    tauri.emit(SCREENS_EVENT, fixture.message)
    await settle()
    expect(posted).toStrictEqual([])
    expect(warn).toHaveBeenCalledWith('W_SCREENS_REQUEST_DROPPED')
  })

  it('answers a failed operation with its code, never its message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { bridge, posted } = start([], {
      ping: () => Promise.reject(new Error('E_LICENCE_REQUIRED')),
      search: () => Promise.reject(new Error('the note "Budget" is locked')),
    })
    await bridge.installed
    tauri.emit(SCREENS_EVENT, { v: 1, id: 1, op: 'ping', args: {} })
    tauri.emit(SCREENS_EVENT, { v: 1, id: 2, op: 'search', args: { query: 'x', scope: 'all' } })
    await settle()
    expect(posted).toStrictEqual([
      { v: 1, id: 1, ok: false, code: 'E_LICENCE_REQUIRED' },
      { v: 1, id: 2, ok: false, code: 'E_SCREENS_OP_FAILED' },
    ])
    expect(warn.mock.calls.flat().join()).not.toContain('Budget')
  })

  it('stops listening and keeps the web shell when the screens did not attach', async () => {
    const { bridge, posted } = start([{ v: 1, id: 1, op: 'ping', args: {} }], undefined, false)
    await expect(bridge.installed).resolves.toBe(false)
    expect(tauri.listening(SCREENS_EVENT)).toBe(0)
    expect(posted).toStrictEqual([])
  })

  it('does not take the requests once it has been stopped', async () => {
    const { bridge } = start()
    bridge.stop()
    await expect(bridge.installed).resolves.toBe(false)
    expect(tauri.invoked).not.toContain('screens_take')
  })

  const notice = { notice: 'tabs.state', tab: 'notes', barHidden: true, attention: false } as const

  it('sends a notice once the screens are known to be installed', async () => {
    const { bridge, posted } = start()
    bridge.notify(notice)
    expect(posted).toStrictEqual([])
    await bridge.installed
    bridge.notify(notice)
    await settle()
    expect(posted).toStrictEqual([{ v: 1, ...notice }])
  })

  it('drops every notice without the screens', async () => {
    const { bridge, posted } = start([], undefined, false)
    await bridge.installed
    bridge.notify(notice)
    await settle()
    expect(posted).toStrictEqual([])
  })

  it('runs only ping until an operation gets its handler', () => {
    expect(Object.keys(SCREENS_HANDLERS)).toStrictEqual(['ping'])
    const sent = new Set(requests.map(([, fixture]) => (fixture.message as { op: string }).op))
    expect([...sent].sort()).toStrictEqual([...SCREENS_OPS].sort())
  })
})
