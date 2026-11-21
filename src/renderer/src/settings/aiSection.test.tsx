// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiSettingsChange, AiSettingsView } from '../../../core/aiProvider'
import { invoke } from '../ipc'
import { AiSection } from './AiSection'

vi.mock('../ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))
vi.stubGlobal('DEVOT_UI_TEST', true)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const http = {
  endpoint: '',
  model: '',
  defaultEndpoint: 'https://api.example.test/v1',
  defaultModel: '',
  key: 'unset',
  reasoning: null,
} as const
const tool = (state: 'ready' | 'signedOut' | 'notInstalled' | 'checking') => ({
  state,
  model: '',
  reasoning: null,
})

const codexModels = {
  state: 'ready',
  defaultModel: 'gpt-5.5',
  models: [
    {
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      tier: 'best',
      reasoning: ['low', 'medium', 'high'],
      defaultReasoning: 'medium',
    },
    {
      id: 'gpt-5.5-mini',
      name: 'GPT-5.5 Mini',
      tier: 'fast',
      reasoning: [],
      defaultReasoning: null,
    },
  ],
}
const claudeModels = {
  state: 'ready',
  defaultModel: null,
  models: [{ id: 'haiku', name: 'Haiku', tier: 'fast', reasoning: [], defaultReasoning: null }],
}
const openaiModels = {
  state: 'ready',
  defaultModel: null,
  models: [
    { id: 'o-small', name: 'O Small', tier: 'fast', reasoning: [], defaultReasoning: null },
    { id: 'o-large', name: 'O Large', tier: null, reasoning: [], defaultReasoning: null },
  ],
}

let stored: AiSettingsView
let host: HTMLDivElement
let root: Root
type Answer = (command: string, args: Record<string, unknown>) => unknown

function rust(answer: Answer = () => undefined) {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const own = answer(command, (args ?? {}) as Record<string, unknown>)
    if (own !== undefined) return own
    if (command === 'ai_settings_get') return stored
    if (command === 'settings_ai_access_summary') return { notebooks: 3, allowed: 1 }
    if (command === 'ai_settings_set') {
      const change = (args as { settings: AiSettingsChange }).settings
      stored = {
        ...stored,
        active: change.active,
        suggestOnIdle: change.suggestOnIdle,
        anthropic: { ...stored.anthropic, ...change.anthropic },
        openai: { ...stored.openai, ...change.openai },
        suggestModel: change.suggestModel ?? null,
        ...(stored.cli
          ? {
              cli: {
                claudeCli: { ...stored.cli.claudeCli, ...change.claudeCli },
                codexCli: { ...stored.cli.codexCli, ...change.codexCli },
              },
            }
          : {}),
      }
      return stored
    }
    if (command === 'ai_models') {
      const { providers } = args as { providers: string[] }
      const all: Record<string, unknown> = {
        codexCli: codexModels,
        claudeCli: claudeModels,
        openai: openaiModels,
      }
      return Object.fromEntries(providers.map((p) => [p, all[p]]))
    }
    if (command === 'ai_key_set') {
      stored = { ...stored, openai: { ...stored.openai, key: 'set' } }
      return stored
    }
    return undefined
  })
}

beforeEach(() => {
  stored = {
    active: 'codexCli',
    suggestOnIdle: false,
    anthropic: http,
    openai: http,
    cli: { codexCli: tool('ready'), claudeCli: tool('ready') },
    suggestModel: null,
  }
  rust()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.mocked(invoke).mockReset()
  localStorage.clear()
})

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

async function pane() {
  await act(async () => root.render(<AiSection />))
  await settle()
}

const calls = (command: string) =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([c]) => c === command)
    .map(([, args]) => args as Record<string, unknown>)

const modelButton = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button.model-popup')].find((b) =>
    b.getAttribute('aria-label')?.startsWith(`${label}:`),
  )!

const click = (el: Element | null | undefined) =>
  act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

const options = () =>
  [...host.querySelectorAll('.model-picker [role="option"]')].map((o) => o.textContent)

const railButton = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('.model-picker-rail-button')].find((b) =>
    b.getAttribute('aria-label')?.startsWith(name),
  )

describe('Settings > AI', () => {
  it('shows the pane before the local tools are checked, and fills it in once they are', async () => {
    const checked = stored
    stored = { ...stored, cli: { codexCli: tool('checking'), claudeCli: tool('checking') } }
    let answer: (view: AiSettingsView) => void = () => undefined
    rust((command) =>
      command === 'ai_cli_refresh'
        ? new Promise<AiSettingsView>((resolve) => {
            answer = resolve
          })
        : undefined,
    )
    await pane()
    expect(host.querySelector('[data-setting="aiSettings.model"]')?.textContent).toContain(
      'Codex · Checking…',
    )
    expect(calls('ai_cli_refresh')).toHaveLength(1)
    expect(calls('ai_models')).toEqual([])

    stored = checked
    await act(async () => answer(checked))
    await settle()
    expect(host.querySelector('[data-setting="aiSettings.model"]')?.textContent).toContain(
      'Codex · Ready',
    )
    expect(calls('ai_models')).toEqual([{ providers: ['claudeCli', 'codexCli'], refresh: false }])
  })

  it('names no provider for the Model setting while the first check decides which one it is', async () => {
    const checked = { ...stored, active: 'claudeCli' as const }
    stored = {
      ...stored,
      active: 'anthropic',
      activePending: true,
      cli: { codexCli: tool('checking'), claudeCli: tool('checking') },
    }
    let answer: (view: AiSettingsView) => void = () => undefined
    rust((command) =>
      command === 'ai_cli_refresh'
        ? new Promise<AiSettingsView>((resolve) => {
            answer = resolve
          })
        : undefined,
    )
    await pane()
    const row = () => host.querySelector('[data-setting="aiSettings.model"]')
    expect(row()?.querySelector('.setting-description')?.textContent).toBe('Checking…')
    expect(row()?.textContent).not.toContain('Claude (Anthropic)')
    expect(modelButton('Model')?.getAttribute('aria-disabled')).toBe('true')
    expect(modelButton('Model')?.querySelector('.model-popup-name')?.textContent).toBe('Checking…')

    stored = checked
    await act(async () => answer(checked))
    await settle()
    expect(row()?.textContent).toContain('Claude Code · Ready')
    expect(modelButton('Model')?.getAttribute('aria-disabled')).toBeNull()
  })

  it('lists the local tools’ models when it opens, and a cloud provider’s only once that provider is opened', async () => {
    stored = { ...stored, openai: { ...http, key: 'set' } }
    await pane()
    expect(calls('ai_models')).toEqual([{ providers: ['claudeCli', 'codexCli'], refresh: false }])
    await click(modelButton('Model'))
    expect(options()).toEqual(
      expect.arrayContaining([expect.stringContaining('GPT-5.5'), 'Other Model ID…']),
    )
    await click(railButton('OpenAI-compatible'))
    await settle()
    expect(calls('ai_models').at(-1)).toEqual({ providers: ['openai'], refresh: false })
    expect(options()).toEqual(expect.arrayContaining([expect.stringContaining('O Small')]))
  })

  it('puts focus back in the search field when Escape leaves Other Model ID, so a second Escape closes the picker', async () => {
    await pane()
    await click(modelButton('Model'))
    const other = [...host.querySelectorAll('.model-picker [role="option"]')].find(
      (o) => o.textContent === 'Other Model ID…',
    )
    await click(other)
    const escape = () =>
      act(async () => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        )
      })
    await escape()
    expect(document.activeElement?.getAttribute('role')).toBe('combobox')
    await escape()
    expect(host.querySelector('.model-picker')).toBeNull()
  })

  it('names a cloud model as its list last showed it, before that list is fetched again', async () => {
    stored = { ...stored, active: 'openai', openai: { ...http, key: 'set', model: 'o-large' } }
    await pane()
    expect(modelButton('Model').getAttribute('aria-label')).toContain('o-large')
    await click(modelButton('Model'))
    await settle()
    act(() => root.unmount())

    vi.mocked(invoke).mockClear()
    root = createRoot(host)
    await pane()
    expect(calls('ai_models')).toEqual([{ providers: ['claudeCli', 'codexCli'], refresh: false }])
    expect(modelButton('Model').getAttribute('aria-label')).toContain('O Large')
  })

  it('adds a model to Recent only once its save is accepted', async () => {
    rust((command) =>
      command === 'ai_settings_set' ? Promise.reject(new Error('E_AI_SETTINGS_WRITE')) : undefined,
    )
    await pane()
    await click(modelButton('Model'))
    const mini = [...host.querySelectorAll('.model-picker [role="option"]')].find((o) =>
      o.textContent?.startsWith('GPT-5.5 Mini'),
    )
    await click(mini)
    await settle()
    expect(localStorage.getItem('devot.ai.recentModels') ?? '[]').toBe('[]')
  })

  it('saves the model picked, with its provider, and shows Default (Medium) first for its reasoning', async () => {
    await pane()
    await click(modelButton('Model'))
    const gpt = [...host.querySelectorAll('.model-picker [role="option"]')].find(
      (o) => o.textContent?.startsWith('GPT-5.5') && !o.textContent.includes('Mini'),
    )
    await click(gpt)
    await settle()
    expect(calls('ai_settings_set').at(-1)?.['settings']).toMatchObject({
      active: 'codexCli',
      codexCli: { model: 'gpt-5.5' },
    })
    await click(modelButton('Model'))
    const levels = [...host.querySelectorAll('.model-picker-level')].map((b) => b.textContent)
    expect(levels).toEqual(['Default (Medium)', 'Low', 'Medium', 'High'])
  })

  it('hides the Reasoning column for a model without levels', async () => {
    stored = {
      ...stored,
      active: 'claudeCli',
      cli: { ...stored.cli!, claudeCli: { ...tool('ready'), model: 'haiku' } },
    }
    await pane()
    await click(modelButton('Model'))
    expect(host.querySelector('.model-picker-reasoning')).toBeNull()
  })

  it('says under Suggest When I Pause why suggestions would not come, and when they are ready', async () => {
    stored = {
      ...stored,
      suggestOnIdle: true,
      cli: { ...stored.cli!, claudeCli: tool('notInstalled') },
      suggestModel: { provider: 'claudeCli', model: '', reasoning: null },
    }
    await pane()
    const status = () => host.querySelector('.ai-suggest-status')?.textContent
    expect(status()).toBe('No suggestions: Claude Code is not installed.')
    stored = { ...stored, cli: { ...stored.cli!, claudeCli: tool('ready') } }
    act(() => root.unmount())
    root = createRoot(host)
    await pane()
    expect(status()).toMatch(/^Ready: /)
  })

  it('offers a cloud suggestion model while a local tool answers the Model setting', async () => {
    await pane()
    expect(host.textContent).toContain('A cloud model with a key keeps suggestions quick.')
    await click(modelButton('Suggestion Model'))
    expect(options()[0]).toContain('Same as Model')
    expect(railButton('OpenAI-compatible')).toBeDefined()
  })

  it('shows Try It’s answer under the model, and drops an answer for a model no longer chosen', async () => {
    let answer: (value: unknown) => void = () => undefined
    rust((command) =>
      command === 'ai_try' ? new Promise((resolve) => (answer = resolve)) : undefined,
    )
    await pane()
    await click(modelButton('Model'))
    await click(host.querySelector('.model-picker-try'))
    expect(host.querySelector('.ai-try-result')?.textContent).toMatch(/^Asking /)
    await act(async () => answer({ provider: 'codexCli', model: '', elapsedMs: 1250 }))
    await settle()
    expect(host.querySelector('.ai-try-result')?.textContent).toBe('Answered in 1.3 s.')
  })

  it('leads with the providers to set up when nothing can answer, and checks a new key by listing its models', async () => {
    stored = {
      ...stored,
      active: 'openai',
      cli: { codexCli: tool('notInstalled'), claudeCli: tool('signedOut') },
    }
    await pane()
    expect(host.textContent).toContain('Choose How Devot Reaches AI')
    expect(host.querySelector('button.model-popup')).toBeNull()
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    }
    await click(host.querySelector('button[aria-label="Add a key for OpenAI-compatible"]'))
    const sheet = host.querySelector('dialog.ai-key-sheet')!
    const input = sheet.querySelector<HTMLInputElement>('input[type="password"]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'sk-test',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      sheet
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await settle()
    expect(calls('ai_key_set')).toEqual([{ provider: 'openai', key: 'sk-test' }])
    expect(calls('ai_models').at(-1)).toEqual({ providers: ['openai'], refresh: true })
    expect(sheet.querySelector('.ai-key-check')?.textContent).toBe('Key works · 2 models found.')
  })

  it('keeps the newer list when an older answer for the same tools comes late', async () => {
    const answers: Array<(value: unknown) => void> = []
    rust((command) => {
      if (command === 'ai_cli_refresh') return stored
      if (command !== 'ai_models') return undefined
      return new Promise((resolve) => answers.push(resolve))
    })
    await pane()
    await click(host.querySelector('.ai-providers-toggle'))
    await click(host.querySelector('button[aria-label="Check Codex again"]'))
    await settle()
    expect(calls('ai_models').at(-1)).toEqual({
      providers: ['claudeCli', 'codexCli'],
      refresh: true,
    })
    await act(async () => answers[1]!({ codexCli: codexModels, claudeCli: claudeModels }))
    const old = {
      ...codexModels,
      models: [{ ...codexModels.models[1]!, id: 'old', name: 'Old Model' }],
    }
    await act(async () => answers[0]!({ codexCli: old, claudeCli: claudeModels }))
    await settle()
    await click(modelButton('Model'))
    expect(options().join()).toContain('GPT-5.5')
    expect(options().join()).not.toContain('Old Model')
  })
})
