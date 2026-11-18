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

  it('shows On This Mac CLI tools, selects one, refreshes status, and saves a CLI model override', async () => {
    let viewState = {
      active: 'claudeCli',
      suggestOnIdle: false,
      anthropic: provider,
      openai: provider,
      cli: {
        claudeCli: { state: 'ready', model: '' },
        codexCli: { state: 'signedOut', model: '' },
      },
    }
    type SettingsPayload = typeof stored & {
      claudeCli?: { model: string }
      codexCli?: { model: string }
    }
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'ai_settings_get') return viewState
      if (command === 'ai_settings_set') {
        const { settings } = args as { settings: SettingsPayload }
        viewState = {
          ...viewState,
          active: settings.active,
          suggestOnIdle: settings.suggestOnIdle,
          anthropic: { ...provider, ...settings.anthropic },
          openai: { ...provider, ...settings.openai },
          cli: {
            claudeCli: {
              ...viewState.cli.claudeCli,
              model: settings.claudeCli?.model ?? viewState.cli.claudeCli.model,
            },
            codexCli: {
              ...viewState.cli.codexCli,
              model: settings.codexCli?.model ?? viewState.cli.codexCli.model,
            },
          },
        }
        return viewState
      }
      if (command === 'ai_cli_refresh') {
        viewState = {
          ...viewState,
          cli: {
            ...viewState.cli,
            codexCli: { ...viewState.cli.codexCli, state: 'ready' },
          },
        }
        return viewState
      }
      return undefined
    })

    await pane()
    const refreshBtn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Refresh',
    )!
    await act(async () => refreshBtn.click())
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'ai_cli_refresh')).toBe(true)

    const useCodex = host.querySelector<HTMLButtonElement>('button[aria-label="Use Codex"]')!
    expect(useCodex.getAttribute('aria-disabled')).toBe('false')
    await act(async () => useCodex.click())
    expect(host.querySelector<HTMLSelectElement>('select[id$="active"]')!.value).toBe('codexCli')

    const codexModel = host.querySelector<HTMLInputElement>('input[aria-label="Codex model"]')!
    act(() => {
      codexModel.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        codexModel,
        'gpt-5.4',
      )
      codexModel.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => codexModel.blur())
    const lastSet = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === 'ai_settings_set')
      .at(-1)?.[1] as { settings: { active: string; codexCli: { model: string } } }
    expect(lastSet.settings.active).toBe('codexCli')
    expect(lastSet.settings.codexCli).toEqual({ model: 'gpt-5.4' })
  })

  it('reconciles active provider after Save Key and Remove Key without re-posting stale active', async () => {
    let viewState = {
      active: 'claudeCli',
      suggestOnIdle: false,
      anthropic: { ...provider, key: 'unset' },
      openai: { ...provider, key: 'unset' },
      cli: {
        claudeCli: { state: 'ready', model: '' },
        codexCli: { state: 'notInstalled', model: '' },
      },
    }
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'ai_settings_get') return viewState
      if (command === 'ai_key_set') {
        viewState = {
          ...viewState,
          active: 'anthropic',
          anthropic: { ...provider, key: 'set' },
        }
        return viewState
      }
      if (command === 'ai_key_clear') {
        viewState = {
          ...viewState,
          active: 'claudeCli',
          anthropic: { ...provider, key: 'unset' },
        }
        return viewState
      }
      return viewState
    })

    await pane()
    const active = host.querySelector<HTMLSelectElement>('select[id$="active"]')!
    expect(active.value).toBe('claudeCli')

    const keyInput = host.querySelector<HTMLInputElement>(
      'input[aria-label="API key for Claude (Anthropic)"]',
    )!
    act(() => {
      keyInput.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        keyInput,
        'sk-ant-test',
      )
      keyInput.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const anthropicSection = keyInput.closest('section')!
    const saveKey = [...anthropicSection.querySelectorAll('button')].find(
      (b) => b.textContent === 'Save Key',
    )!
    await act(async () => saveKey.click())
    expect(active.value).toBe('anthropic')
    expect(
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Use Claude Code"]')
        ?.getAttribute('aria-disabled'),
    ).toBe('false')

    await act(async () => field('endpoint').blur())
    const removeKey = [...anthropicSection.querySelectorAll('button')].find(
      (b) => b.textContent === 'Remove Key',
    )!
    await act(async () => removeKey.click())
    expect(active.value).toBe('claudeCli')
    expect(
      host.querySelector<HTMLButtonElement>('button[aria-label="Claude Code is active"]'),
    ).not.toBeNull()

    await act(async () => root.render(<></>))
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'ai_settings_set')).toEqual([])
  })

  it('keeps validation errors visible when Refresh is clicked directly after an invalid model draft', async () => {
    let viewState = {
      active: 'claudeCli',
      suggestOnIdle: false,
      anthropic: provider,
      openai: provider,
      cli: {
        claudeCli: { state: 'ready', model: '' },
        codexCli: { state: 'signedOut', model: '' },
      },
    }
    const callOrder: string[] = []
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      callOrder.push(command)
      if (command === 'ai_settings_get') return viewState
      if (command === 'ai_settings_set') {
        const { settings } = args as { settings: { codexCli?: { model: string } } }
        if (settings.codexCli?.model.startsWith('-')) {
          throw new Error('E_AI_MODEL_INVALID')
        }
        return viewState
      }
      if (command === 'ai_cli_refresh') {
        viewState = {
          ...viewState,
          cli: {
            ...viewState.cli,
            codexCli: { ...viewState.cli.codexCli, state: 'ready' },
          },
        }
        return viewState
      }
      return undefined
    })

    await pane()
    const codexModel = host.querySelector<HTMLInputElement>('input[aria-label="Codex model"]')!
    act(() => {
      codexModel.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        codexModel,
        '-bad',
      )
      codexModel.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const refreshBtn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Refresh',
    )!
    await act(async () => refreshBtn.click())

    expect(callOrder).toEqual(['ai_settings_get', 'ai_settings_set', 'ai_cli_refresh'])
    expect(codexModel.value).toBe('')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'The AI settings could not be saved.',
    )
  })

  it('reconciles active provider refs when unmounted while Save Key is pending so unmount does not post stale active', async () => {
    const viewState = {
      active: 'claudeCli',
      suggestOnIdle: false,
      anthropic: { ...provider, key: 'unset' },
      openai: { ...provider, key: 'unset' },
      cli: {
        claudeCli: { state: 'ready', model: '' },
        codexCli: { state: 'notInstalled', model: '' },
      },
    }
    let finishKey!: (next: typeof viewState) => void
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'ai_settings_get') return Promise.resolve(viewState)
      if (command === 'ai_key_set') {
        return new Promise((resolve) => {
          finishKey = resolve
        })
      }
      return Promise.resolve(viewState)
    })

    await pane()
    const keyInput = host.querySelector<HTMLInputElement>(
      'input[aria-label="API key for Claude (Anthropic)"]',
    )!
    act(() => {
      keyInput.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        keyInput,
        'sk-ant-test',
      )
      keyInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const anthropicSection = keyInput.closest('section')!
    const saveKey = [...anthropicSection.querySelectorAll('button')].find(
      (b) => b.textContent === 'Save Key',
    )!
    act(() => {
      saveKey.click()
    })

    await act(async () => root.render(<></>))
    finishKey({
      ...viewState,
      active: 'anthropic',
      anthropic: { ...provider, key: 'set' },
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'ai_settings_set')).toEqual([])
  })

  it('keeps validation errors visible when blur fails with an invalid model before clicking Refresh', async () => {
    let viewState = {
      active: 'claudeCli',
      suggestOnIdle: false,
      anthropic: provider,
      openai: provider,
      cli: {
        claudeCli: { state: 'ready', model: '' },
        codexCli: { state: 'signedOut', model: '' },
      },
    }
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'ai_settings_get') return viewState
      if (command === 'ai_settings_set') {
        const { settings } = args as { settings: { codexCli?: { model: string } } }
        if (settings.codexCli?.model.startsWith('-')) throw new Error('E_AI_MODEL_INVALID')
        return viewState
      }
      if (command === 'ai_cli_refresh') {
        viewState = {
          ...viewState,
          cli: { ...viewState.cli, codexCli: { state: 'ready', model: '' } },
        }
        return viewState
      }
      return undefined
    })

    await pane()
    const codexModel = host.querySelector<HTMLInputElement>('input[aria-label="Codex model"]')!
    act(() => {
      codexModel.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        codexModel,
        '-bad',
      )
      codexModel.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => codexModel.blur())
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'The AI settings could not be saved.',
    )

    const refreshBtn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Refresh',
    )!
    await act(async () => refreshBtn.click())
    expect(
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Use Codex"]')
        ?.getAttribute('aria-disabled'),
    ).toBe('false')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'The AI settings could not be saved.',
    )
  })

  it('keeps validation errors visible when blur fails concurrently with clicking Refresh', async () => {
    let viewState = {
      active: 'claudeCli',
      suggestOnIdle: false,
      anthropic: provider,
      openai: provider,
      cli: {
        claudeCli: { state: 'ready', model: '' },
        codexCli: { state: 'signedOut', model: '' },
      },
    }
    const callOrder: string[] = []
    let rejectSave!: (err: unknown) => void
    vi.mocked(invoke).mockImplementation((command) => {
      callOrder.push(command)
      if (command === 'ai_settings_get') return Promise.resolve(viewState)
      if (command === 'ai_settings_set') {
        return new Promise((_resolve, reject) => {
          rejectSave = reject
        })
      }
      if (command === 'ai_cli_refresh') {
        viewState = {
          ...viewState,
          cli: { ...viewState.cli, codexCli: { state: 'ready', model: '' } },
        }
        return Promise.resolve(viewState)
      }
      return Promise.resolve(undefined)
    })

    await pane()
    const codexModel = host.querySelector<HTMLInputElement>('input[aria-label="Codex model"]')!
    act(() => {
      codexModel.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        codexModel,
        '-bad',
      )
      codexModel.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const refreshBtn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Refresh',
    )!
    act(() => {
      codexModel.blur()
      refreshBtn.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      rejectSave(new Error('E_AI_MODEL_INVALID'))
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(callOrder).toEqual(['ai_settings_get', 'ai_settings_set', 'ai_cli_refresh'])
    expect(codexModel.value).toBe('')
    expect(
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Use Codex"]')
        ?.getAttribute('aria-disabled'),
    ).toBe('false')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'The AI settings could not be saved.',
    )
  })
})
