import { describe, expect, it, vi } from 'vitest'
import { runKeySheet, type KeySheetPhase, type KeySheetSteps } from './AiKeySheet'

vi.spyOn(console, 'warn').mockImplementation(() => undefined)

function steps(overrides: Partial<KeySheetSteps> = {}) {
  const order: string[] = []
  const all: KeySheetSteps = {
    saveEndpoint: async (endpoint) => void order.push(`endpoint ${endpoint}`),
    saveKey: async () => void order.push('key'),
    removeKey: async () => void order.push('remove'),
    listModels: async () => {
      order.push('list')
      return {
        state: 'ready',
        defaultModel: null,
        models: [{ id: 'm', name: 'M', tier: null, reasoning: [], defaultReasoning: null }],
      }
    },
    ...overrides,
  }
  return { all, order }
}

async function run(
  input: { key: string; endpoint: string; storedEndpoint: string },
  s: KeySheetSteps,
) {
  const phases: KeySheetPhase[] = []
  await runKeySheet(input, s, (p) => phases.push(p))
  return phases
}

describe('the key sheet', () => {
  it('saves a changed endpoint before the key, then checks the key by listing models', async () => {
    const { all, order } = steps()
    const phases = await run({ key: 'sk', endpoint: 'https://e.test', storedEndpoint: '' }, all)
    expect(order).toEqual(['endpoint https://e.test', 'key', 'list'])
    expect(phases.map((p) => p.kind)).toEqual(['saving', 'checking', 'checked'])
    expect(phases.at(-1)).toEqual({ kind: 'checked', models: ['M'] })
  })

  it('stops at a refused key, before any list is asked for', async () => {
    const { all, order } = steps({ saveKey: () => Promise.reject(new Error('E_AI_KEYCHAIN')) })
    const phases = await run({ key: 'sk', endpoint: '', storedEndpoint: '' }, all)
    expect(order).toEqual([])
    expect(phases.at(-1)).toEqual({
      kind: 'failed',
      message: 'aiSettings.keyFailed',
      code: 'E_AI_KEYCHAIN',
      keySaved: false,
    })
  })

  it('says the key was kept when only its list failed', async () => {
    const { all } = steps({
      listModels: async () => ({ state: 'failed', code: 'E_AI_AUTH_FAILED' }),
    })
    const phases = await run({ key: 'sk', endpoint: '', storedEndpoint: '' }, all)
    expect(phases.at(-1)).toMatchObject({
      kind: 'failed',
      keySaved: true,
      code: 'E_AI_AUTH_FAILED',
    })
  })
})
