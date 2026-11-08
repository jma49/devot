// @vitest-environment happy-dom
// Settings > Integrations' AI Tools and Local HTTP API send every field of their choices with each
// save, one save after another: a reload or a refused save must not change what the next one sends.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '../ipc'
import { HttpApiSection } from './HttpApiSection'
import { McpAccessSection } from './McpAccessSection'

vi.mock('../ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

type Args = Record<string, unknown>

/** Rust's side: what it holds, the saves it was sent, and each save's answer held until `answer`. */
function fakeRust(stored: Args, save: string, load: string) {
  const sent: Args[] = []
  const held: { args: Args; resolve: (refused?: string) => void }[] = []
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === load) return { ...stored }
    if (command === save) {
      const change = args as Args
      sent.push(change)
      await new Promise<void>((resolve, reject) =>
        held.push({
          args: change,
          resolve: (refused) => (refused ? reject(new Error(refused)) : resolve()),
        }),
      )
      Object.assign(stored, change)
      return { ...stored }
    }
    if (command === 'background_state') return 'normal'
    return undefined
  })
  return {
    sent,
    answer: async (refused?: string) => {
      await act(async () => held.shift()?.resolve(refused))
    },
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.mocked(invoke).mockReset()
  vi.restoreAllMocks()
})

const mcpStored = () => ({
  enabled: false,
  scope: 'readWrite',
  backgroundStart: false,
  reachable: false,
  problem: null,
})

async function showMcp() {
  await act(async () =>
    root.render(
      <McpAccessSection
        changed={0}
        onChange={onChange}
        summary={undefined}
        onChooseNotebooks={() => {}}
      />,
    ),
  )
}
const onChange = () => {}

const switches = () => [...host.querySelectorAll<HTMLInputElement>('input[role="switch"]')]
const flip = (box: HTMLInputElement) => act(() => box.click())
const choose = (select: HTMLSelectElement, value: string) =>
  act(() => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
const focusWindow = () => act(async () => window.dispatchEvent(new Event('focus')))

it('a reload while a save runs keeps the choice queued behind it', async () => {
  const rust = fakeRust(mcpStored(), 'mcp_access_set', 'mcp_access_get')
  await showMcp()
  await flip(switches()[0]!)
  await choose(host.querySelector('select')!, 'read')
  await focusWindow()
  await rust.answer()
  await rust.answer()
  expect(rust.sent).toEqual([
    { enabled: true, scope: 'readWrite', backgroundStart: false },
    { enabled: true, scope: 'read', backgroundStart: false },
  ])
  expect(host.querySelector('select')!.value).toBe('read')
})

it('a refused AI Tools save is not sent again with the next change', async () => {
  const rust = fakeRust(mcpStored(), 'mcp_access_set', 'mcp_access_get')
  await showMcp()
  await flip(switches()[0]!)
  await rust.answer('E_SETTINGS_WRITE')
  expect(switches()[0]!.checked).toBe(false)
  await choose(host.querySelector('select')!, 'read')
  await rust.answer()
  expect(rust.sent.at(-1)).toEqual({ enabled: false, scope: 'read', backgroundStart: false })
  expect(switches()[0]!.checked).toBe(false)
})

it('a change made while a refused AI Tools save ran is still sent', async () => {
  const rust = fakeRust(mcpStored(), 'mcp_access_set', 'mcp_access_get')
  await showMcp()
  await flip(switches()[0]!)
  await choose(host.querySelector('select')!, 'read')
  await rust.answer('E_SETTINGS_WRITE')
  await rust.answer()
  expect(rust.sent.at(-1)).toEqual({ enabled: false, scope: 'read', backgroundStart: false })
})

it('a refused Local HTTP API save is not sent again when the port changes', async () => {
  const rust = fakeRust(
    { enabled: false, port: 8080, scope: 'read', listening: null, problem: null, token: 'set' },
    'http_api_set',
    'http_api_get',
  )
  await act(async () => root.render(<HttpApiSection />))
  await flip(switches()[0]!)
  await rust.answer('E_SETTINGS_WRITE')
  expect(switches()[0]!.checked).toBe(false)

  const port = host.querySelector<HTMLInputElement>('input[type="number"]')!
  act(() => {
    port.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(port, '9090')
    port.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => port.blur())
  await rust.answer()
  expect(rust.sent.at(-1)).toEqual({ enabled: false, port: 9090 })
  expect(switches()[0]!.checked).toBe(false)
})
