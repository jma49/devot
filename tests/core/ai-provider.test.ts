// The rule in front of every AI request, on real SQLite: nothing is sent unless
// the user started it, and not from a notebook that does not allow AI access.
// The wire formats and the keychain are covered in Rust (src-tauri/src/ai).
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  asAiGenerated,
  asAiSettingsView,
  createAiGenerator,
  createBookService,
  createClock,
  createIdGenerator,
  TEMPLATES_BOOK_ID,
  type AiGenerateInput,
  type AiTransport,
  type AiTrigger,
  type Entitlements,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

const GENERATED = {
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  text: 'Hello',
  stop: 'end',
  usage: { inputTokens: 3, outputTokens: 2 },
}

const INPUT: AiGenerateInput = { messages: [{ role: 'user', content: 'Summarise this.' }] }

function setup(answer: unknown = GENERATED, entitlements?: Entitlements) {
  const storage = openSqliteAdapter(join(tempDir('devot-ai-provider-'), 'devot.sqlite'))
  open.push(storage)
  const books = createBookService({
    storage,
    clock: createClock('mac1'),
    newId: createIdGenerator(),
  })
  const sent: AiGenerateInput[] = []
  const transport: AiTransport = {
    generate: (input) => {
      sent.push(input)
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    },
  }
  return {
    books,
    sent,
    ai: createAiGenerator({ storage, transport, ...(entitlements ? { entitlements } : {}) }),
  }
}

const user = (...books: string[]): AiTrigger => ({ by: 'user', books })

describe('the licence', () => {
  it('sends nothing while the licence does not include AI', async () => {
    let licensed = false
    const { ai, sent } = setup(GENERATED, { has: (f) => f !== 'aiProviders' || licensed })
    await expect(ai.generate(INPUT, user())).rejects.toThrow('E_LICENCE_REQUIRED')
    expect(sent).toEqual([])
    licensed = true
    await ai.generate(INPUT, user())
    expect(sent).toHaveLength(1)
  })
})

describe('the access rule', () => {
  it('sends a request the user started, with text of their own', async () => {
    const { ai, sent } = setup()
    expect(await ai.generate(INPUT, user())).toEqual(GENERATED)
    expect(sent).toEqual([INPUT])
  })

  it('sends text from a notebook that allows AI access', async () => {
    const { ai, books, sent } = setup()
    const shared = await books.create('Shared', null)
    await books.setAiAccess(shared, true)
    await ai.generate(INPUT, user(shared))
    expect(sent).toHaveLength(1)
  })

  it('sends nothing from a notebook that does not allow it, or that does not exist', async () => {
    const { ai, books, sent } = setup()
    const shared = await books.create('Shared', null)
    const priv = await books.create('Private', null)
    await books.setAiAccess(shared, true)
    for (const trigger of [
      user(priv),
      user(shared, priv),
      user('0197a2f0-0000-7000-8000-000000000000'),
    ]) {
      await expect(ai.generate(INPUT, trigger)).rejects.toThrow('E_AI_ACCESS_DENIED')
    }
    expect(sent).toEqual([])
  })

  it('does not count a sub-notebook as allowed because its parent is', async () => {
    const { ai, books, sent } = setup()
    const shared = await books.create('Shared', null)
    const inside = await books.create('Inside', shared)
    await books.setAiAccess(shared, true)
    await expect(ai.generate(INPUT, user(inside))).rejects.toThrow('E_AI_ACCESS_DENIED')
    expect(sent).toEqual([])
  })

  it('never counts Templates', async () => {
    const { ai, sent } = setup()
    await expect(ai.generate(INPUT, user(TEMPLATES_BOOK_ID))).rejects.toThrow('E_AI_ACCESS_DENIED')
    expect(sent).toEqual([])
  })

  it('sends nothing the user did not start', async () => {
    const { ai, sent } = setup()
    for (const trigger of [{ by: 'timer', books: [] }, { books: [] }, {}]) {
      await expect(ai.generate(INPUT, trigger as unknown as AiTrigger)).rejects.toThrow(
        'E_AI_NOT_TRIGGERED',
      )
    }
    expect(sent).toEqual([])
  })
})

describe('the answer', () => {
  it('passes on the code Rust failed with', async () => {
    const { ai } = setup(new Error('E_AI_KEY_MISSING'))
    await expect(ai.generate(INPUT, user())).rejects.toThrow('E_AI_KEY_MISSING')
  })

  it('refuses an answer of the wrong shape', async () => {
    for (const answer of [
      null,
      'text',
      {},
      { ...GENERATED, stop: 'done' },
      { ...GENERATED, text: 1 },
    ]) {
      const { ai } = setup(answer)
      await expect(ai.generate(INPUT, user())).rejects.toThrow('E_AI_RESPONSE_INVALID')
    }
  })

  it('takes an answer without a token count', () => {
    expect(asAiGenerated({ ...GENERATED, usage: null })?.usage).toBeNull()
    expect(
      asAiGenerated({ ...GENERATED, usage: { inputTokens: -1, outputTokens: 2 } }),
    ).toBeUndefined()
    expect(asAiGenerated({ ...GENERATED, provider: 'other' })).toBeUndefined()
  })
})

describe('the settings Rust reports', () => {
  const provider = (key: string) => ({
    endpoint: 'https://api.openai.com/v1',
    model: '',
    defaultEndpoint: 'https://api.openai.com/v1',
    defaultModel: '',
    key,
  })

  it('reads a snapshot and refuses anything else', () => {
    const view = {
      active: 'openai',
      suggestOnIdle: false,
      anthropic: provider('set'),
      openai: provider('unset'),
    }
    expect(asAiSettingsView(view)).toEqual(view)
    expect(asAiSettingsView({ ...view, suggestOnIdle: true })?.suggestOnIdle).toBe(true)
    const { suggestOnIdle: _, ...older } = view
    expect(asAiSettingsView(older)?.suggestOnIdle).toBe(false)
    expect(asAiSettingsView({ ...view, suggestOnIdle: 'yes' })?.suggestOnIdle).toBe(false)
    expect(asAiSettingsView({ ...view, active: 'other' })).toBeUndefined()
    expect(asAiSettingsView({ ...view, openai: provider('unknown') })).toEqual({
      ...view,
      openai: provider('unknown'),
    })
    expect(asAiSettingsView({ ...view, openai: provider('maybe') })).toBeUndefined()
    expect(asAiSettingsView({ ...view, anthropic: undefined })).toBeUndefined()
    expect(asAiSettingsView(null)).toBeUndefined()
  })
})
