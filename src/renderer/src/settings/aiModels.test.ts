import { describe, expect, it } from 'vitest'
import type { AiCatalogModel, AiSettingsView } from '../../../core/aiProvider'
import {
  addRecent,
  aiProviders,
  choiceName,
  choose,
  chooseReasoning,
  choosableRows,
  isCurrentRow,
  isFirstRun,
  pickerSections,
  providerState,
  reasoningLevels,
  settingsChange,
  suggestChoice,
  suggestStatus,
  type Catalogs,
} from './aiModels'

const http = (key: 'set' | 'unset' | 'unknown' | 'unavailable', model = '', defaultModel = '') => ({
  endpoint: 'https://api.example.com',
  model,
  defaultEndpoint: 'https://api.example.com',
  defaultModel,
  key,
  reasoning: null,
})

function settings(over: Partial<AiSettingsView> = {}): AiSettingsView {
  return {
    active: 'codexCli',
    suggestOnIdle: true,
    anthropic: http('unset', '', 'claude-sonnet-5-5'),
    openai: http('unset'),
    cli: {
      claudeCli: { state: 'ready', model: '', reasoning: null },
      codexCli: { state: 'ready', model: 'gpt-6.1-sol', reasoning: 'medium' },
    },
    suggestModel: null,
    ...over,
  }
}

const model = (id: string, over: Partial<AiCatalogModel> = {}): AiCatalogModel => ({
  id,
  name: id.toUpperCase(),
  tier: null,
  reasoning: ['low', 'medium', 'high'],
  defaultReasoning: 'medium',
  ...over,
})

const catalogs: Catalogs = {
  codexCli: {
    state: 'ready',
    models: [
      model('gpt-6.2-sol', { tier: 'best' }),
      model('gpt-6.1-sol'),
      model('gpt-6.2-astra', { tier: 'fast' }),
    ],
    defaultModel: null,
  },
  claudeCli: {
    state: 'ready',
    models: [
      model('opus'),
      model('sonnet'),
      model('haiku', { reasoning: [], defaultReasoning: null }),
    ],
    defaultModel: null,
  },
  anthropic: { state: 'idle' },
}

describe('provider state', () => {
  it('reads a key or a tool', () => {
    const view = settings({
      anthropic: http('set'),
      openai: http('unknown'),
      cli: {
        claudeCli: { state: 'signedOut', model: '', reasoning: null },
        codexCli: { state: 'notInstalled', model: '', reasoning: null },
      },
    })
    expect(providerState(view, 'anthropic')).toBe('ready')
    expect(providerState(view, 'openai')).toBe('keyUnknown')
    expect(providerState(view, 'claudeCli')).toBe('signedOut')
    expect(providerState(view, 'codexCli')).toBe('notInstalled')
  })

  it('leaves the local tools out of a build without them', () => {
    const { cli: _, ...view } = settings()
    expect(aiProviders(view)).toEqual(['anthropic', 'openai'])
    expect(aiProviders(settings())).toEqual(['codexCli', 'claudeCli', 'anthropic', 'openai'])
  })

  it('is a first run only while nothing answers the Model setting', () => {
    expect(isFirstRun(settings())).toBe(false)
    expect(isFirstRun(settings({ active: 'anthropic' }))).toBe(true)
    expect(
      isFirstRun(settings({ active: 'anthropic', anthropic: http('set', '', 'claude') })),
    ).toBe(false)
    // A key without a model is chosen in the picker, not set up again.
    expect(isFirstRun(settings({ active: 'openai', openai: http('set') }))).toBe(false)
  })
})

describe('the picker rows', () => {
  const sections = (over: Partial<Parameters<typeof pickerSections>[0]> = {}) =>
    pickerSections({
      view: settings(),
      target: 'main',
      catalogs,
      recent: [],
      rail: 'codexCli',
      query: '',
      ...over,
    })

  it('lists the rail provider, its default first for a local tool, then Other Model ID', () => {
    const [codex] = sections()
    expect(codex?.title).toEqual({ kind: 'provider', provider: 'codexCli', ready: true })
    expect(codex?.rows.map((r) => (r.kind === 'model' ? r.model : r.kind))).toEqual([
      '',
      'gpt-6.2-sol',
      'gpt-6.1-sol',
      'gpt-6.2-astra',
      'other',
    ])
    expect(codex?.rows[1]).toMatchObject({ tier: 'best' })
  })

  it('puts Recent first with up to three entries, and Same as Model first for suggestions', () => {
    const recent = [
      { provider: 'claudeCli', model: 'haiku' },
      { provider: 'codexCli', model: 'custom-id' },
      { provider: 'anthropic', model: 'claude-opus-5-5' },
    ] as const
    const [same, rec] = sections({ target: 'suggest', recent })
    expect(same?.rows).toEqual([{ kind: 'same' }])
    expect(rec?.title).toEqual({ kind: 'recent' })
    expect(rec?.rows).toEqual([
      {
        kind: 'model',
        provider: 'claudeCli',
        model: 'haiku',
        name: 'HAIKU',
        tier: null,
        recent: 0,
      },
      {
        kind: 'model',
        provider: 'codexCli',
        model: 'custom-id',
        name: 'custom-id',
        tier: null,
        recent: 1,
      },
      {
        kind: 'model',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        name: 'claude-opus-5-5',
        tier: null,
        recent: 2,
      },
    ])
  })

  it('searches every provider whose list is in, by name or ID', () => {
    const found = sections({ query: 'SOL' })
    expect(found.map((s) => s.title)).toEqual([
      { kind: 'provider', provider: 'codexCli', ready: true },
    ])
    expect(choosableRows(found).map((r) => (r.kind === 'model' ? r.model : r.kind))).toEqual([
      'gpt-6.2-sol',
      'gpt-6.1-sol',
    ])
    expect(choosableRows(sections({ query: 'haiku' }))).toMatchObject([
      { provider: 'claudeCli', model: 'haiku' },
    ])
  })

  it('offers a query that matches nothing as a model ID of the rail provider', () => {
    expect(sections({ query: ' my-model ' })).toEqual([
      { title: null, rows: [{ kind: 'useId', provider: 'codexCli', id: 'my-model' }] },
    ])
  })

  it('says why a provider that is not set up lists nothing', () => {
    const [anthropic] = sections({ rail: 'anthropic' })
    expect(anthropic).toEqual({
      title: { kind: 'provider', provider: 'anthropic', ready: false },
      rows: [],
      note: { kind: 'blocked', state: 'needsKey' },
    })
  })

  it('says a list is on its way or failed, and keeps the model in use choosable', () => {
    const view = settings({ active: 'anthropic', anthropic: http('set', 'claude-custom') })
    const [loading] = sections({
      view,
      rail: 'anthropic',
      catalogs: { anthropic: { state: 'loading', request: 4 } },
    })
    expect(loading?.note).toEqual({ kind: 'loading' })
    expect(loading?.rows).toEqual([
      {
        kind: 'model',
        provider: 'anthropic',
        model: 'claude-custom',
        name: 'claude-custom',
        tier: null,
      },
      { kind: 'other', provider: 'anthropic' },
    ])
    const [failed] = sections({
      view,
      rail: 'anthropic',
      catalogs: { anthropic: { state: 'failed', code: 'E_AI_AUTH_FAILED' } },
    })
    expect(failed?.note).toEqual({ kind: 'failed', code: 'E_AI_AUTH_FAILED' })
  })

  it('marks what the target holds now', () => {
    const view = settings()
    const row = {
      kind: 'model',
      provider: 'codexCli',
      model: 'gpt-6.1-sol',
      name: null,
      tier: null,
    } as const
    expect(isCurrentRow(view, 'main', row)).toBe(true)
    expect(isCurrentRow(view, 'suggest', row)).toBe(false)
    expect(isCurrentRow(view, 'suggest', { kind: 'same' })).toBe(true)
  })
})

describe('choosing', () => {
  it('makes a main pick the active provider, keeping a level the new model takes', () => {
    const next = choose(settings(), 'main', catalogs, {
      provider: 'codexCli',
      model: 'gpt-6.2-sol',
    })
    expect(next.active).toBe('codexCli')
    expect(next.cli?.codexCli).toEqual({
      state: 'ready',
      model: 'gpt-6.2-sol',
      reasoning: 'medium',
    })
  })

  it('drops a level the new model does not take', () => {
    const view = settings({
      cli: {
        claudeCli: { state: 'ready', model: 'opus', reasoning: 'high' },
        codexCli: { state: 'ready', model: '', reasoning: null },
      },
    })
    const next = choose(view, 'main', catalogs, { provider: 'claudeCli', model: 'haiku' })
    expect(next.active).toBe('claudeCli')
    expect(next.cli?.claudeCli).toMatchObject({ model: 'haiku', reasoning: null })
  })

  it('names a suggestion model, and Same as Model clears it', () => {
    const named = choose(settings(), 'suggest', catalogs, {
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
    })
    expect(named.active).toBe('codexCli')
    expect(named.suggestModel).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      reasoning: null,
    })
    expect(choose(named, 'suggest', catalogs, null).suggestModel).toBeNull()
  })

  it('picks a level for the target', () => {
    expect(chooseReasoning(settings(), 'main', 'high').cli?.codexCli.reasoning).toBe('high')
    expect(chooseReasoning(settings(), 'main', null).cli?.codexCli.reasoning).toBeNull()
    expect(chooseReasoning(settings(), 'suggest', 'low').suggestModel).toEqual({
      provider: 'codexCli',
      model: '',
      reasoning: 'low',
    })
  })

  it('offers the levels of the model chosen, none for a model without', () => {
    expect(
      reasoningLevels(catalogs, { provider: 'claudeCli', model: 'opus', reasoning: null }),
    ).toEqual({
      levels: ['low', 'medium', 'high'],
      fallback: 'medium',
    })
    expect(
      reasoningLevels(catalogs, { provider: 'claudeCli', model: 'haiku', reasoning: null }).levels,
    ).toEqual([])
  })

  it('names a choice by its model, its ID, or null for an unnamed default', () => {
    expect(
      choiceName(catalogs, { provider: 'codexCli', model: 'gpt-6.1-sol', reasoning: null }),
    ).toBe('GPT-6.1-SOL')
    expect(choiceName(catalogs, { provider: 'openai', model: 'llama3', reasoning: null })).toBe(
      'llama3',
    )
    expect(choiceName(catalogs, { provider: 'codexCli', model: '', reasoning: null })).toBeNull()
  })

  it('follows the Model setting for a suggestion model with no model of its own', () => {
    const view = settings({ suggestModel: { provider: 'codexCli', model: '', reasoning: 'low' } })
    expect(suggestChoice(view)).toEqual({
      provider: 'codexCli',
      model: 'gpt-6.1-sol',
      reasoning: 'low',
    })
  })

  it('keeps the three latest picks, newest first, each once', () => {
    let recent = addRecent([], { provider: 'codexCli', model: 'a' })
    recent = addRecent(recent, { provider: 'claudeCli', model: 'b' })
    recent = addRecent(recent, { provider: 'codexCli', model: 'a' })
    recent = addRecent(recent, { provider: 'openai', model: 'c' })
    recent = addRecent(recent, { provider: 'anthropic', model: 'd' })
    expect(recent).toEqual([
      { provider: 'anthropic', model: 'd' },
      { provider: 'openai', model: 'c' },
      { provider: 'codexCli', model: 'a' },
    ])
  })

  it('sends every field Settings changes', () => {
    const view = settings({ suggestModel: { provider: 'anthropic', model: '', reasoning: null } })
    expect(settingsChange(view)).toEqual({
      active: 'codexCli',
      suggestOnIdle: true,
      anthropic: { endpoint: 'https://api.example.com', model: '', reasoning: null },
      openai: { endpoint: 'https://api.example.com', model: '', reasoning: null },
      claudeCli: { model: '', reasoning: null },
      codexCli: { model: 'gpt-6.1-sol', reasoning: 'medium' },
      suggestModel: { provider: 'anthropic', model: '', reasoning: null },
    })
  })
})

describe('the suggestion status line', () => {
  const licensed = { licensed: true, allowedNotebooks: 2 }

  it('says nothing while suggestions on a pause are off', () => {
    expect(suggestStatus(settings({ suggestOnIdle: false }), licensed)).toEqual({ kind: 'off' })
  })

  it('names the first thing that stops them, licence, then notebooks, then the provider', () => {
    const blocked = settings({
      suggestModel: { provider: 'anthropic', model: '', reasoning: null },
    })
    expect(suggestStatus(blocked, { licensed: false, allowedNotebooks: 0 })).toEqual({
      kind: 'licence',
    })
    expect(suggestStatus(blocked, { licensed: true, allowedNotebooks: 0 })).toEqual({
      kind: 'noNotebooks',
    })
    expect(suggestStatus(blocked, licensed)).toEqual({
      kind: 'provider',
      provider: 'anthropic',
      code: 'E_AI_KEY_MISSING',
    })
    const signedOut = settings({
      cli: {
        claudeCli: { state: 'ready', model: '', reasoning: null },
        codexCli: { state: 'signedOut', model: '', reasoning: null },
      },
    })
    expect(suggestStatus(signedOut, licensed)).toMatchObject({ code: 'E_AI_AUTH_FAILED' })
    const noModel = settings({
      suggestModel: { provider: 'openai', model: '', reasoning: null },
      openai: http('set'),
    })
    expect(suggestStatus(noModel, licensed)).toMatchObject({
      provider: 'openai',
      code: 'E_AI_MODEL_MISSING',
    })
  })

  it('is ready with the model that will answer, before the notebook count is known too', () => {
    expect(suggestStatus(settings(), { licensed: true, allowedNotebooks: undefined })).toEqual({
      kind: 'ready',
      choice: { provider: 'codexCli', model: 'gpt-6.1-sol', reasoning: 'medium' },
    })
  })
})
