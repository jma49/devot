import { describe, expect, it } from 'vitest'
import type { AiSettingsView } from '../../../core/aiProvider'
import { createAiSettingsQueue } from './aiSettingsQueue'

const provider = {
  endpoint: '',
  model: '',
  defaultEndpoint: '',
  defaultModel: '',
  key: 'unset',
  reasoning: null,
} as const
const view = (active: AiSettingsView['active'], suggestOnIdle = false): AiSettingsView => ({
  active,
  suggestOnIdle,
  anthropic: provider,
  openai: provider,
  suggestModel: null,
})

function queue() {
  const sent: AiSettingsView[] = []
  const answers: Array<(refuse?: boolean) => void> = []
  const shown: string[] = []
  const refused: unknown[] = []
  const q = createAiSettingsQueue({
    save: (next) => {
      sent.push(next)
      return new Promise((resolve, reject) => {
        answers.push((refuse) =>
          refuse ? reject(new Error('E_AI_ENDPOINT_INVALID')) : resolve(next),
        )
      })
    },
    same: (a, b) => a.active === b.active && a.suggestOnIdle === b.suggestOnIdle,
    onShown: (v) => shown.push(`${v.active} ${v.suggestOnIdle}`),
    onRefused: (e) => refused.push(e),
  })
  q.loaded(view('anthropic'))
  return { q, sent, answers, shown, refused }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the AI settings queue', () => {
  it('shows a change at once and sends the next only once the one before answered', async () => {
    const { q, sent, answers } = queue()
    void q.change((v) => ({ ...v, active: 'openai' }))
    void q.change((v) => ({ ...v, suggestOnIdle: true }))
    expect(q.shown()).toMatchObject({ active: 'openai', suggestOnIdle: true })
    await settle()
    expect(sent).toHaveLength(1)
    answers[0]!()
    await settle()
    // The second change is built from the first one's answer, so it keeps the provider.
    expect(sent.map((v) => `${v.active} ${v.suggestOnIdle}`)).toEqual([
      'openai false',
      'openai true',
    ])
  })

  it('takes a refused change back and reports it, keeping the changes after it', async () => {
    const { q, answers, refused } = queue()
    void q.change((v) => ({ ...v, active: 'openai' }))
    void q.change((v) => ({ ...v, suggestOnIdle: true }))
    await settle()
    answers[0]!(true)
    await settle()
    expect(refused).toHaveLength(1)
    expect(q.shown()).toMatchObject({ active: 'anthropic', suggestOnIdle: true })
    answers[1]!()
    await settle()
    expect(q.shown()).toMatchObject({ active: 'anthropic', suggestOnIdle: true })
  })

  it('settles true once a change is saved, false once it is refused', async () => {
    const { q, answers } = queue()
    const saved = q.change((v) => ({ ...v, active: 'openai' }))
    const refused = q.change((v) => ({ ...v, suggestOnIdle: true }))
    await settle()
    answers[0]!()
    await settle()
    answers[1]!(true)
    expect(await saved).toBe(true)
    expect(await refused).toBe(false)
  })

  it('sends nothing for a change that changes nothing', async () => {
    const { q, sent } = queue()
    await q.change((v) => ({ ...v }))
    expect(sent).toEqual([])
  })

  it('runs other calls in turn and takes their answer', async () => {
    const { q, answers } = queue()
    void q.change((v) => ({ ...v, active: 'openai' }))
    const ran = q.run(async () => view('claudeCli'))
    await settle()
    answers[0]!()
    expect((await ran).active).toBe('claudeCli')
    expect(q.shown()?.active).toBe('claudeCli')
    await expect(q.run(() => Promise.reject(new Error('E_AI_KEYCHAIN')))).rejects.toThrow(
      'E_AI_KEYCHAIN',
    )
    expect(q.shown()?.active).toBe('claudeCli')
  })
})
