import { describe, expect, it } from 'vitest'
import { areas, en, type MessageKey } from '.'

const modules = Object.entries(areas)
const prefixOf = (key: string) => key.split('.')[0] ?? ''

describe('the English catalog', () => {
  it('types a key that no area module defines as an error', () => {
    const known: MessageKey = 'sidebar.label'
    // @ts-expect-error
    const misspelled: MessageKey = 'sidebar.labell'
    expect([known, misspelled]).toHaveLength(2)
  })

  it('defines each key in one area module, since a later one would override it', () => {
    const seen = new Map<string, string>()
    const twice: string[] = []
    for (const [area, { messages }] of modules) {
      for (const key of Object.keys(messages)) {
        const first = seen.get(key)
        if (first) twice.push(`${key} in ${first} and ${area}`)
        seen.set(key, area)
      }
    }
    expect(twice).toEqual([])
    expect(seen.size).toBe(Object.keys(en).length)
  })

  it('gives each prefix to one area module', () => {
    const owners = new Map<string, string>()
    const twice: string[] = []
    for (const [area, { prefixes }] of modules) {
      for (const prefix of prefixes) {
        const first = owners.get(prefix)
        if (first) twice.push(`${prefix} in ${first} and ${area}`)
        owners.set(prefix, area)
      }
    }
    expect(twice).toEqual([])
  })

  it("keeps in each area module only keys of that module's prefixes", () => {
    const strays = modules.flatMap(([area, { prefixes, messages }]) =>
      Object.keys(messages)
        .filter((key) => !prefixes.includes(prefixOf(key)))
        .map((key) => `${key} in ${area}`),
    )
    expect(strays).toEqual([])
  })

  it('uses every prefix an area module lists', () => {
    const unused = modules.flatMap(([area, { prefixes, messages }]) =>
      prefixes
        .filter((p) => !Object.keys(messages).some((key) => prefixOf(key) === p))
        .map((p) => `${p} in ${area}`),
    )
    expect(unused).toEqual([])
  })
})
