// Next edit suggestions on real SQLite: nothing is sent unless the user asked (the key, or the idle setting they turned on),
// the note's notebook allows AI access and a provider is set up; and only the text near the caret goes.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAiGenerator,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createSuggester,
  SUGGEST_AFTER_CHARS,
  SUGGEST_BEFORE_CHARS,
  suggestContext,
  TEMPLATES_BOOK_ID,
  type AiGenerateInput,
  type AiProviderView,
  type AiSettingsView,
  type AiTransport,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

const provider = (key: AiProviderView['key'] = 'set', model = 'claude-sonnet-5-5') => ({
  endpoint: 'https://api.anthropic.com',
  model,
  defaultEndpoint: 'https://api.anthropic.com',
  defaultModel: model,
  key,
})

function setup(view: Partial<AiSettingsView> = {}, licensed = () => true) {
  const storage = openSqliteAdapter(join(tempDir('devot-ai-suggest-'), 'devot.sqlite'))
  open.push(storage)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const books = createBookService({ storage, clock, newId })
  const notes = createNoteService({ storage, clock, newId })
  const sent: AiGenerateInput[] = []
  const transport: AiTransport = {
    generate: (input) => {
      sent.push(input)
      return Promise.resolve({
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        text: ' and then ship it.',
        stop: 'end',
        usage: null,
      })
    },
  }
  let settings: AiSettingsView = {
    active: 'anthropic',
    suggestOnIdle: false,
    anthropic: provider(),
    openai: provider('unset', ''),
    ...view,
  }
  const suggester = createSuggester({
    generator: createAiGenerator({ storage, transport }),
    bookOf: async (id) => (await notes.read(id)).bookId,
    listBooks: () => storage.listBooks(),
    settings: () => Promise.resolve(settings),
    entitlements: { has: (feature) => feature !== 'aiProviders' || licensed() },
  })
  return {
    books,
    notes,
    sent,
    suggester,
    change: (next: Partial<AiSettingsView>) => (settings = { ...settings, ...next }),
  }
}

const CONTEXT = { before: 'We will write the plan', after: '' }

describe('next edit suggestions', () => {
  it('ask the provider for a note in a notebook that allows AI access', async () => {
    const { books, notes, suggester, sent } = setup()
    const shared = await books.create('Shared', null)
    await books.setAiAccess(shared, true)
    const note = await notes.create('Plan', shared)
    expect(await suggester.suggest(note, CONTEXT, 'key')).toBe(' and then ship it.')
    expect(sent).toHaveLength(1)
  })

  it('send nothing for a note in a notebook without AI access, in none, or in Templates', async () => {
    const { books, notes, suggester, sent, change } = setup()
    const priv = await books.create('Private', null)
    const inNone = await notes.create('Loose', null)
    const inPrivate = await notes.create('Plan', priv)
    const inTemplates = await notes.create('Template', TEMPLATES_BOOK_ID)
    change({ suggestOnIdle: true })
    for (const id of [inNone, inPrivate, inTemplates]) {
      await expect(suggester.suggest(id, CONTEXT, 'key')).rejects.toThrow('E_AI_ACCESS_DENIED')
      expect(await suggester.suggest(id, CONTEXT, 'idle')).toBeNull()
    }
    expect(sent).toEqual([])
  })

  it('send nothing on a pause while the idle setting is off, whatever the notebook', async () => {
    const { books, notes, suggester, sent, change } = setup()
    const shared = await books.create('Shared', null)
    await books.setAiAccess(shared, true)
    const note = await notes.create('Plan', shared)
    expect(await suggester.suggest(note, CONTEXT, 'idle')).toBeNull()
    expect(sent).toEqual([])
    change({ suggestOnIdle: true })
    expect(await suggester.suggest(note, CONTEXT, 'idle')).toBe(' and then ship it.')
    change({ suggestOnIdle: false })
    expect(await suggester.suggest(note, CONTEXT, 'idle')).toBeNull()
    expect(sent).toHaveLength(1)
  })

  it('send nothing without AI in the licence: a pause stays quiet, a key press says why', async () => {
    let licensed = false
    const { books, notes, suggester, sent, change } = setup({}, () => licensed)
    const shared = await books.create('Shared', null)
    await books.setAiAccess(shared, true)
    const note = await notes.create('Plan', shared)
    change({ suggestOnIdle: true })
    expect(await suggester.suggest(note, CONTEXT, 'idle')).toBeNull()
    await expect(suggester.suggest(note, CONTEXT, 'key')).rejects.toThrow('E_LICENCE_REQUIRED')
    expect(sent).toEqual([])
    licensed = true
    expect(await suggester.suggest(note, CONTEXT, 'key')).toBe(' and then ship it.')
  })

  it('send nothing without a provider set up', async () => {
    const { books, notes, suggester, sent, change } = setup({ anthropic: provider('unset') })
    const shared = await books.create('Shared', null)
    await books.setAiAccess(shared, true)
    const note = await notes.create('Plan', shared)
    await expect(suggester.suggest(note, CONTEXT, 'key')).rejects.toThrow('E_AI_KEY_MISSING')
    change({ active: 'openai', openai: provider('set', '') })
    await expect(suggester.suggest(note, CONTEXT, 'key')).rejects.toThrow('E_AI_MODEL_MISSING')
    expect(sent).toEqual([])
  })

  it('send only the text near the caret', async () => {
    const { books, notes, suggester, sent } = setup()
    const shared = await books.create('Shared', null)
    await books.setAiAccess(shared, true)
    const note = await notes.create('Plan', shared)
    const text = `SECRET-HEAD ${'a'.repeat(10_000)} CARET ${'b'.repeat(10_000)} SECRET-TAIL`
    const caret = text.indexOf('CARET') + 5
    const context = suggestContext((from, to) => text.slice(from, to), text.length, caret)
    await suggester.suggest(note, context, 'key')
    const content = sent[0]!.messages.map((m) => m.content).join('')
    expect(content).not.toContain('SECRET')
    expect(content).toContain('CARET')
    expect(content.length).toBeLessThan(SUGGEST_BEFORE_CHARS + SUGGEST_AFTER_CHARS + 100)
  })
})
