import { describe, expect, it } from 'vitest'
import { MAX_WORD_GOAL, wordGoal } from './wordGoal'

describe('wordGoal', () => {
  it('reads a positive whole number from the front matter', () => {
    expect(wordGoal('---\nword-goal: 1500\n---\n# Draft')).toBe(1500)
    expect(wordGoal('---\ntags: [a]\nword-goal:   800  \nstatus: active\n---\n')).toBe(800)
    expect(wordGoal('---\r\nword-goal: 50\r\n---\r\nText')).toBe(50)
    expect(wordGoal("---\nword-goal: '1200'\n---\n")).toBe(1200)
    expect(wordGoal('---\nword-goal: "1,200"\n---\n')).toBe(1200)
    expect(wordGoal('---\nword-goal: 1_000 # chapter\n---\n')).toBe(1000)
  })

  it('has no goal without front matter or a closing fence', () => {
    expect(wordGoal('word-goal: 100')).toBeNull()
    expect(wordGoal('# Title\n---\nword-goal: 100\n---\n')).toBeNull()
    expect(wordGoal('---\nword-goal: 100\n')).toBeNull()
    expect(wordGoal('')).toBeNull()
  })

  it('reads only the key at the top level', () => {
    expect(wordGoal('---\nmeta:\n  word-goal: 100\n---\n')).toBeNull()
    expect(wordGoal('---\nmy-word-goal: 100\n---\n')).toBeNull()
    expect(wordGoal('---\nWord-Goal: 100\n---\n')).toBeNull()
  })

  it('ignores a value that is not a sensible goal', () => {
    for (const value of ['0', '-5', '12.5', 'lots', '', '1e3', `${MAX_WORD_GOAL + 1}`]) {
      expect(wordGoal(`---\nword-goal: ${value}\n---\n`)).toBeNull()
    }
    expect(wordGoal(`---\nword-goal: ${MAX_WORD_GOAL}\n---\n`)).toBe(MAX_WORD_GOAL)
  })

  it('keeps the first of two keys', () => {
    expect(wordGoal('---\nword-goal: 300\nword-goal: 900\n---\n')).toBe(300)
  })

  it('does not read past the fence in a long note', () => {
    const body = 'word-goal: 5\n'.repeat(50_000)
    expect(wordGoal(`---\ntitle: x\n---\n${body}`)).toBeNull()
  })
})
