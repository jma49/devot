// @vitest-environment happy-dom
// A typed endpoint or model is kept when the pane is left without leaving the field first.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '../ipc'
import { AiSection } from './AiSection'

vi.mock('../ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))
vi.stubGlobal('DEVOT_UI_TEST', true)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const provider = { endpoint: '', model: '', defaultEndpoint: '', defaultModel: '', key: 'unset' }
const stored = { active: 'openai', suggestOnIdle: false, anthropic: provider, openai: provider }

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'ai_settings_get') return stored
    if (command === 'ai_settings_set') {
      const { settings } = args as { settings: typeof stored }
      return {
        ...settings,
        anthropic: { ...provider, ...settings.anthropic },
        openai: { ...provider, ...settings.openai },
      }
    }
    return undefined
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.mocked(invoke).mockReset()
  Reflect.deleteProperty(document, 'visibilityState')
})

async function pane() {
  await act(async () => root.render(<AiSection />))
}

const field = (part: 'endpoint' | 'model') =>
  host.querySelector<HTMLInputElement>(`input[id$="openai-${part}"]`)!

function type(part: 'endpoint' | 'model', value: string) {
  const input = field(part)
  act(() => {
    input.focus()
    for (let end = 1; end <= value.length; end += 1) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        value.slice(0, end),
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
}

const saved = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === 'ai_settings_set')
    .map(([, args]) => (args as { settings: typeof stored }).settings.openai)

describe('the AI pane', () => {
  it('saves nothing while a field is typed into', async () => {
    await pane()
    type('endpoint', 'http://localhost:11434')
    expect(saved()).toEqual([])
  })

  it('keeps a typed field when it is closed', async () => {
    await pane()
    type('endpoint', 'http://localhost:11434')
    type('model', 'llama3')
    await act(async () => root.render(<></>))
    expect(saved().at(-1)).toEqual({ endpoint: 'http://localhost:11434', model: 'llama3' })
  })

  it('keeps a typed field when the app goes to the background', async () => {
    await pane()
    type('model', 'llama3')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(saved()).toEqual([{ endpoint: '', model: 'llama3' }])
  })

  it('saves an unchanged pane never', async () => {
    await pane()
    await act(async () => root.render(<></>))
    expect(saved()).toEqual([])
  })

  it('sends a save only once the one before answered, with what is asked then', async () => {
    const answers: Array<() => void> = []
    const events: string[] = []
    const respond = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command !== 'ai_settings_set') return respond(command, args)
      const { settings } = args as { settings: typeof stored }
      events.push(`sent ${settings.active}`)
      return new Promise((resolve) => {
        answers.push(() => {
          events.push(`answered ${settings.active}`)
          resolve(respond(command, args))
        })
      })
    })
    await pane()
    type('endpoint', 'http://192.168.1.4:11434')
    await act(async () => field('endpoint').blur())
    expect(events).toEqual(['sent openai'])
    const active = host.querySelector<HTMLSelectElement>('select[id$="active"]')!
    act(() => {
      active.value = 'anthropic'
      active.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      for (const answer of answers.splice(0).reverse()) answer()
    })
    await act(async () => {
      for (const answer of answers.splice(0)) answer()
    })
    expect(events).toEqual([
      'sent openai',
      'answered openai',
      'sent anthropic',
      'answered anthropic',
    ])
    expect(saved().at(-1)).toEqual({
      endpoint: 'http://192.168.1.4:11434',
      model: '',
    })
    expect(active.value).toBe('anthropic')
  })

  it('shows a choice made while a save runs, and a second tap undoes it', async () => {
    const answers: Array<() => void> = []
    const respond = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command !== 'ai_settings_set') return respond(command, args)
      return new Promise((resolve) => answers.push(() => resolve(respond(command, args))))
    })
    await pane()
    type('endpoint', 'http://192.168.1.4:11434')
    await act(async () => field('endpoint').blur())
    const active = host.querySelector<HTMLSelectElement>('select[id$="active"]')!
    act(() => {
      active.value = 'anthropic'
      active.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(active.value).toBe('anthropic')
    const toggle = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    act(() => toggle.click())
    expect(toggle.checked).toBe(true)
    act(() => toggle.click())
    expect(toggle.checked).toBe(false)
    while (answers.length > 0) await act(async () => answers.shift()!())
    const sent = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'ai_settings_set')
      .map(([, args]) => (args as { settings: typeof stored }).settings)
      .map((settings) => ({ active: settings.active, suggestOnIdle: settings.suggestOnIdle }))
    expect(sent.at(-1)).toEqual({ active: 'anthropic', suggestOnIdle: false })
    expect(active.value).toBe('anthropic')
    expect(toggle.checked).toBe(false)
  })
})
