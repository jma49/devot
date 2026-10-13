import { describe, expect, it } from 'vitest'
import { fillWelcome, welcomeContent } from './content'

describe('first-launch content', () => {
  it('fills every key and ID placeholder from the registry', () => {
    const { notes } = welcomeContent()
    expect(notes).toHaveLength(2)
    for (const note of notes) expect(note.body).not.toMatch(/\{\{/)
    expect(notes[0]?.body).toContain('⌘N')
    expect(notes[1]?.body).toContain('devot://note/')
    expect(notes[1]?.files?.[0]?.data.length).toBeGreaterThan(0)
  })

  it('refuses an unknown placeholder', () => {
    expect(() => fillWelcome('{{key:no.such}}')).toThrow('E_WELCOME_PLACEHOLDER')
    expect(() => fillWelcome('{{id:nobody}}')).toThrow('E_WELCOME_PLACEHOLDER')
  })
})
