import { describe, expect, it } from 'vitest'
import { keptMessage, pausedMessage, readStatus } from './mirror'

describe('the mirror status from Rust', () => {
  it('reads a status, and nothing else', () => {
    expect(
      readStatus({
        revision: 3,
        generation: 2,
        folder: '~/Notes',
        includeAttachments: false,
        paused: 'E_MIRROR_FOLDER_MISSING',
        size: 120,
        kept: ['Plan (edited outside Devot).md', 4],
        keptCount: 30,
      }),
    ).toEqual({
      revision: 3,
      value: {
        generation: 2,
        folder: '~/Notes',
        includeAttachments: false,
        paused: 'E_MIRROR_FOLDER_MISSING',
        size: 120,
        kept: ['Plan (edited outside Devot).md'],
        keptCount: 30,
      },
    })
    for (const bad of [
      null,
      'x',
      {},
      { revision: -1, generation: 0, size: 0 },
      { revision: 0, generation: 0, size: 'x' },
    ]) {
      expect(readStatus(bad)).toBeUndefined()
    }
    // A size not known yet (the manifest not read since the folder was chosen).
    expect(
      readStatus({ revision: 1, generation: 1, size: null, folder: '~/Notes' })?.value,
    ).toEqual({
      generation: 1,
      folder: '~/Notes',
      includeAttachments: true,
      paused: null,
      size: null,
      kept: [],
      keptCount: 0,
    })
    // A pause that is not a code is not shown as one.
    expect(
      readStatus({ revision: 0, generation: 0, size: 0, folder: null, paused: 'note text' })?.value
        .paused,
    ).toBeNull()
  })
})

describe('the mirror notices', () => {
  it('say why the mirror is paused, with the code', () => {
    expect(pausedMessage('E_MIRROR_FOLDER_MISSING')).toBe(
      'The mirror is paused: its folder is missing (E_MIRROR_FOLDER_MISSING). It resumes once the folder is back.',
    )
    expect(pausedMessage('E_MIRROR_FOLDER_READ_ONLY')).toContain('cannot be written')
    // Without its manifest the mirror cannot go on by itself: the notice says what to do.
    expect(pausedMessage('E_MIRROR_MANIFEST_MISSING')).toBe(
      'The mirror is paused: the list of files Devot wrote in its folder (.devot-mirror.json) is missing (E_MIRROR_MANIFEST_MISSING). Put it back, or choose the folder again to go on.',
    )
    expect(pausedMessage('E_MIRROR_MANIFEST_INVALID')).toBe(
      'The mirror is paused: the list of files Devot wrote in its folder (.devot-mirror.json) cannot be read (E_MIRROR_MANIFEST_INVALID). Choose the folder again to go on.',
    )
    for (const code of ['E_MIRROR_MANIFEST_MISSING', 'E_MIRROR_MANIFEST_INVALID']) {
      expect(pausedMessage(code)).not.toContain('resumes')
    }
    // Any other code: the general notice.
    expect(pausedMessage('E_MIRROR_FOLDER_OTHER')).toBe(
      'The mirror is paused (E_MIRROR_FOLDER_OTHER). It resumes once its folder can be written again.',
    )
  })

  it('name the first kept files and count the rest', () => {
    expect(keptMessage(['Plan (edited outside Devot).md'], 1, 'en')).toBe(
      'A file edited outside Devot was kept under a new name: Plan (edited outside Devot).md.',
    )
    expect(keptMessage(['a', 'b'], 2, 'en')).toBe(
      '2 files edited outside Devot were kept under new names: a and b.',
    )
    // Rust names the first 20 and counts them all.
    expect(keptMessage(['a', 'b', 'c', 'd'], 1200, 'en')).toBe(
      '1,200 files edited outside Devot were kept under new names: a, b, c, and 1,197 more.',
    )
  })
})
