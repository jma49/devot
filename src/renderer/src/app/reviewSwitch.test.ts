import { describe, expect, it } from 'vitest'
import { followReviewSwitch, type ReviewSwitch } from './reviewSwitch'

const started: ReviewSwitch = { noteId: 'n1', switchedTo: 'edit', shown: false }

describe('the mode Review Changes switched to from Preview', () => {
  it('waits in Preview for the switch, then puts Preview back when the last change is reviewed', () => {
    expect(followReviewSwitch(started, { noteId: 'n1', unseen: 2, mode: 'preview' })).toEqual({
      next: started,
      toPreview: false,
    })
    const shown = followReviewSwitch(started, { noteId: 'n1', unseen: 2, mode: 'edit' })
    expect(shown).toEqual({ next: { ...started, shown: true }, toPreview: false })
    expect(followReviewSwitch(shown.next, { noteId: 'n1', unseen: 0, mode: 'edit' })).toEqual({
      next: undefined,
      toPreview: true,
    })
  })

  it('forgets the switch once the owner goes back to Preview by hand, so a later Edit stays', () => {
    const shown = { ...started, shown: true }
    const back = followReviewSwitch(shown, { noteId: 'n1', unseen: 2, mode: 'preview' })
    expect(back).toEqual({ next: undefined, toPreview: false })
    expect(followReviewSwitch(back.next, { noteId: 'n1', unseen: 0, mode: 'edit' })).toEqual({
      next: undefined,
      toPreview: false,
    })
  })

  it('forgets it for another note or another editor mode, and never forces Preview then', () => {
    const shown = { ...started, shown: true }
    for (const now of [
      { noteId: 'n2', unseen: 0, mode: 'edit' as const },
      { noteId: 'n1', unseen: 0, mode: 'split' as const },
      { noteId: 'n1', unseen: 2, mode: 'split' as const },
    ]) {
      expect(followReviewSwitch(shown, now)).toEqual({ next: undefined, toPreview: false })
    }
  })
})
