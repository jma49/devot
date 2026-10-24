import { describe, expect, it } from 'vitest'
import { proposalParts } from '../../core/aiEdit'
import { aiEditFailure, proposalRows } from './aiEditView'

describe('the proposal rows', () => {
  it('fold long runs of unchanged lines, keeping two on each side of a change', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'old', 'f', 'g', 'h', 'i', 'j'].join('\n')
    const rows = proposalRows(proposalParts(before, before.replace('old', 'new')))
    expect(rows).toEqual([
      { kind: 'skipped', count: 3 },
      { kind: 'same', text: 'd', part: 0 },
      { kind: 'same', text: 'e', part: 0 },
      { kind: 'removed', text: 'old', part: 1 },
      { kind: 'added', text: 'new', part: 1 },
      { kind: 'same', text: 'f', part: 2 },
      { kind: 'same', text: 'g', part: 2 },
      { kind: 'skipped', count: 3 },
    ])
  })

  it('show a short run whole, and a check box before each change when there are several', () => {
    const rows = proposalRows(proposalParts('one\nkeep\ntwo', 'ONE\nkeep\nTWO'))
    expect(rows.map((r) => r.kind)).toEqual([
      'take',
      'removed',
      'added',
      'same',
      'take',
      'removed',
      'added',
    ])
  })
})

describe('why there is no proposal', () => {
  it('says what to change, with the code, and whether asking again can help', () => {
    expect(aiEditFailure('E_AI_KEY_MISSING')).toEqual({
      message: 'No AI provider is set up. Add a key in Settings > AI. (E_AI_KEY_MISSING)',
      retry: false,
    })
    expect(aiEditFailure('E_AI_ACCESS_DENIED').message).toContain('Allow AI Access')
    expect(aiEditFailure('E_AI_TIMEOUT').retry).toBe(true)
    expect(aiEditFailure('E_SOMETHING_ELSE').message).toBe(
      'The proposal could not be made or applied. (E_SOMETHING_ELSE)',
    )
    expect(aiEditFailure('E_AI_SELECTION_TOO_LARGE').message).toContain('20,000 characters')
  })
})
