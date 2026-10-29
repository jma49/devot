import { describe, expect, it } from 'vitest'
import { draftFromTemplate, isStarterTemplate } from '../../src/core'
import { en } from '../../src/renderer/src/i18n/en'
import { starterTemplate, starterTemplates } from '../../src/renderer/src/starterTemplates'

describe('starter templates', () => {
  it('are the five named ones, with IDs no stored note has, each with instructions', () => {
    const all = starterTemplates()
    expect(all.map((t) => t.title)).toEqual([
      'Brainstorming',
      'Debugging',
      'Learning',
      'Planning',
      'Daily Report',
    ])
    expect(all.every((t) => isStarterTemplate(t.id))).toBe(true)
    expect(all.every((t) => t.body.includes('> # !Instructions'))).toBe(true)
    expect(starterTemplate('starter:planning')?.title).toBe('Planning')
    expect(starterTemplate('starter:nope')).toBeUndefined()
  })

  it('take their title and text from the message catalog', () => {
    const keys = Object.keys(en).filter((key) => key.startsWith('templates.starter.'))
    expect(keys).toHaveLength(starterTemplates().length * 2)
    for (const template of starterTemplates()) {
      const name = template.id.slice('starter:'.length)
      expect(template.title).toBe(en[`templates.starter.${name}.title` as keyof typeof en])
      expect(template.body).toBe(en[`templates.starter.${name}.body` as keyof typeof en])
    }
  })

  it('make a dated note from the daily report and drop its instructions', () => {
    const daily = starterTemplates().find((t) => t.title === 'Daily Report')!
    expect(daily.body).toContain('{{date}}')
    const made = draftFromTemplate(daily, {
      now: Date.UTC(2026, 2, 3, 12),
      offsetAt: () => 0,
    })
    expect(made.title).toBe('Daily Report 2026-03-03')
    expect(made.body.trim().startsWith('# Daily Report 2026-03-03')).toBe(true)
    expect(made.body).not.toContain('!Instructions')
  })
})
