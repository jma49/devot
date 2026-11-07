import { describe, expect, it } from 'vitest'
import { createClock, createIdGenerator, createNoteService } from '../../src/core'
import {
  MAX_WARM_LANGUAGES,
  WARM_NOTES,
  libraryWarmFeatures,
  warmFeatures,
} from '../../src/core/preview/warmFeatures'
import { tempSqliteAdapter } from '../support/sqlite-adapter'

const fence = (lang: string) => `\`\`\`${lang}\nx\n\`\`\``

describe('warmFeatures', () => {
  it('finds nothing to warm in notes without code, math or emoji', () => {
    expect(warmFeatures(['# Plain\n\nJust **text** at $ 5.', 'Costs $5.'])).toEqual({
      languages: [],
      math: false,
      emoji: false,
    })
  })

  it('lists code languages in order of first use, lowercased and without repeats', () => {
    const notes = [[fence('python'), '~~~ Rust {.x}\nfn\n~~~'].join('\n\n'), fence('PYTHON')]
    expect(warmFeatures(notes).languages).toEqual(['python', 'rust'])
  })

  it('finds fences inside lists and quotes', () => {
    const notes = [
      '- Item\n\n  ```go\n  x\n  ```',
      '> ```js\n> x\n> ```',
      '1. Step\n   ~~~sql\n   x\n   ~~~',
    ]
    expect(warmFeatures(notes).languages).toEqual(['go', 'js', 'sql'])
  })

  it('takes prices for prices, not math', () => {
    expect(warmFeatures(['It costs $5 and $10, or $20 in all.']).math).toBe(false)
  })

  it('finds math and emoji in any of the notes', () => {
    expect(warmFeatures(['plain', 'Inline $a + b$.'])).toMatchObject({ math: true, emoji: false })
    expect(warmFeatures(['$$\nx\n$$'])).toMatchObject({ math: true })
    expect(warmFeatures(['plain', 'Done :tada:'])).toMatchObject({ math: false, emoji: true })
  })

  it('warms at most a dozen languages', () => {
    const note = Array.from({ length: 20 }, (_, i) => fence(`lang${i}`)).join('\n\n')
    expect(warmFeatures([note]).languages).toHaveLength(MAX_WARM_LANGUAGES)
  })
})

describe('libraryWarmFeatures', () => {
  it('warms what the open note and the first listed notes use, and nothing further down', async () => {
    const storage = tempSqliteAdapter('devot-warm-')
    const notes = createNoteService({
      storage,
      clock: createClock('mac1'),
      newId: createIdGenerator(),
      saveDelayMs: 5,
    })
    const make = async (body: string) => {
      const id = await notes.create('Note')
      await notes.setBody(id, body)
      return id
    }
    const listed = [await make(fence('go')), await make('Euler: $e^{i\\pi}$')]
    for (let i = listed.length; i < WARM_NOTES; i += 1) listed.push(await make('plain'))
    listed.push(await make(`${fence('haskell')} :tada:`))
    await notes.flush()

    expect(await libraryWarmFeatures(storage, fence('sql'), listed)).toEqual({
      languages: ['sql', 'go'],
      math: true,
      emoji: false,
    })
  })
})
