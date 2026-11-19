import { afterEach, describe, expect, it, vi } from 'vitest'

import { invoke } from '../ipc'
import { loadAiModels, tryAiModel } from './aiProviders'

vi.mock('../ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))

afterEach(() => {
  vi.mocked(invoke).mockReset()
})

describe('the model lists', () => {
  it('asks Rust only for the providers named', async () => {
    const openai = { state: 'failed', code: 'E_AI_KEY_MISSING' }
    vi.mocked(invoke).mockResolvedValue({ openai })
    await expect(loadAiModels(['openai'], true)).resolves.toEqual({ openai })
    expect(invoke).toHaveBeenCalledWith('ai_models', { providers: ['openai'], refresh: true })
  })

  it('refuses an answer of the wrong shape', async () => {
    vi.mocked(invoke).mockResolvedValue({ openai: { state: 'maybe' } })
    await expect(loadAiModels(['openai'])).rejects.toThrow('E_AI_RESPONSE_INVALID')
  })
})

describe('Try It', () => {
  it('sends the provider, model and level', async () => {
    const tried = { provider: 'codexCli', model: 'gpt-a', elapsedMs: 900 }
    vi.mocked(invoke).mockResolvedValue(tried)
    await expect(tryAiModel('codexCli', 'gpt-a', 'low')).resolves.toEqual(tried)
    expect(invoke).toHaveBeenCalledWith('ai_try', {
      provider: 'codexCli',
      model: 'gpt-a',
      reasoning: 'low',
    })
  })
})
