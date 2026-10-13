import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { USAGE_EVENTS } from '../../src/core/usage'

// Usage events never carry note content, titles, names or IDs. The catalog
// is the only way an event gets its properties, so these rules hold for
// every event the app can record.

/** Words that would mean a property describes or identifies content. */
const FORBIDDEN = new Set([
  'body',
  'content',
  'email',
  'file',
  'host',
  'id',
  'ids',
  'key',
  'markdown',
  'name',
  'names',
  'path',
  'query',
  'tag',
  'text',
  'title',
  'url',
  'user',
  'uuid',
  'word',
])

const words = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

// The same patterns the Rust command checks (src-tauri/src/usage.rs).
const EVENT_NAME = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/
const PROPERTY_KEY = /^[a-z][a-zA-Z0-9]{0,31}$/
const ENUM_VALUE = /^[a-z0-9][a-z0-9_+-]{0,31}$/

describe('the usage event catalog', () => {
  const events = Object.entries(USAGE_EVENTS)

  it('names events and properties in the shapes storage accepts', () => {
    for (const [name, properties] of events) {
      expect(name).toMatch(EVENT_NAME)
      expect(Object.keys(properties).length).toBeLessThanOrEqual(16)
      for (const key of Object.keys(properties)) expect(key).toMatch(PROPERTY_KEY)
    }
  })

  it('has no property that names or identifies content', () => {
    for (const [name, properties] of events) {
      for (const key of Object.keys(properties)) {
        const bad = words(key).filter((w) => FORBIDDEN.has(w))
        expect({ where: `${name}.${key}`, bad }).toEqual({ where: `${name}.${key}`, bad: [] })
      }
    }
  })

  it('declares only enums of short fixed tokens, counts and durations', () => {
    for (const [name, properties] of events) {
      for (const [key, property] of Object.entries(properties)) {
        // The event and key go into the compared value, so a failure names them.
        const where = `${name}.${key}`
        expect({ where, kind: property.kind }).toEqual({
          where,
          kind: expect.stringMatching(/^(enum|count|duration)$/),
        })
        if (property.kind !== 'enum') continue
        expect({ where, values: property.values.length }).toEqual({
          where,
          values: new Set(property.values).size,
        })
        expect(property.values.length).toBeGreaterThan(0)
        for (const value of property.values)
          expect({ where, value }).toEqual({ where, value: expect.stringMatching(ENUM_VALUE) })
      }
    }
  })
})

describe('where usage events live', () => {
  it('stays out of the notes database, so it never syncs or reaches devot-mcp', () => {
    const migrations = readdirSync('src-tauri/migrations')
      .map((f) => readFileSync(`src-tauri/migrations/${f}`, 'utf8'))
      .join('\n')
    expect(migrations).not.toMatch(/usage_events/i)
    const mcp = readdirSync('src/mcp')
      .map((f) => readFileSync(`src/mcp/${f}`, 'utf8'))
      .join('\n')
    // Neither the event store's file nor the catalog.
    expect(mcp).not.toMatch(/usage\.sqlite|usage_events|core\/usage/)
  })
})
