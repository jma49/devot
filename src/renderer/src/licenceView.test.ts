import { describe, expect, it } from 'vitest'
import {
  BUY_URL,
  LICENCE_UNKNOWN,
  readLicence,
  trialOver,
  trialRunning,
  type LicenceSnapshot,
} from './licence'
import {
  licenceProblem,
  planLicenceLink,
  reminderDue,
  reminderText,
  stateSentence,
  timeLeft,
  trialSentence,
} from './licenceView'

const ID = '5vEvzHainWD0cA2Ht_ljHg'
const HOUR = 3_600_000
/** 2026-10-27 14:00 in the test's time zone. */
const END = new Date(2026, 9, 27, 14, 0).getTime()
const OTHER_ID = '3f4lHWhFWnUPeDt7yIa3rw'
const held = (over: Partial<LicenceSnapshot> = {}): LicenceSnapshot => ({
  gated: true,
  state: 'valid',
  code: null,
  id: ID,
  licensee: 'buyer@example.com',
  plan: 'pro',
  trial: { state: 'ended', endsAt: END, code: null },
  ...over,
})
const none: LicenceSnapshot = {
  ...LICENCE_UNKNOWN,
  gated: true,
  trial: { state: 'ended', endsAt: END, code: null },
}
const offer = { id: ID, licensee: 'buyer@example.com', state: 'valid' } as const

describe('readLicence', () => {
  it('takes what Rust sends and nothing it would not', () => {
    expect(readLicence(held())).toEqual(held())
    expect(readLicence({ ...held(), id: 'short', plan: 'team' })).toEqual(
      held({ id: null, plan: null }),
    )
    expect(readLicence({ ...held(), updatesUntil: '2027-10-24' })).toEqual(held())
    expect(readLicence({ ...held(), code: 'a note title' })?.code).toBeNull()
    expect(readLicence({ ...held(), state: 'updatesEnded' })).toBeUndefined()
    expect(readLicence({ state: 'none' })).toBeUndefined()
    expect(readLicence(null)).toBeUndefined()
  })
})

describe('the license pages', () => {
  it('live under one address', () => {
    expect(BUY_URL).toBe('https://licence.devot.online/buy')
  })
})

describe('what the windows say', () => {
  it('gives each state a sentence', () => {
    expect(stateSentence(none)).toMatch(/^No license is added/)
    expect(stateSentence({ ...none, gated: false })).toMatch(/does not check licenses/)
    expect(stateSentence({ ...none, code: 'E_LICENCE_KEYCHAIN' })).toMatch(
      /keychain \(E_LICENCE_KEYCHAIN\)/,
    )
    expect(stateSentence(held())).toBe('Editing, sync and AI are unlocked on this device.')
    expect(stateSentence(held({ state: 'revoked' }))).toMatch(/revoked/)
    expect(stateSentence({ ...none, state: 'invalid', code: 'E_LICENCE_SIGNATURE' })).toMatch(
      /could not be verified \(E_LICENCE_SIGNATURE\)/,
    )
  })

  it('says why a key was refused', () => {
    expect(licenceProblem('E_LICENCE_MALFORMED')).toBe(
      'This is not a complete Devot license key. (E_LICENCE_MALFORMED)',
    )
    expect(licenceProblem('E_LICENCE_UNKNOWN_KID')).toMatch(/Update Devot/)
    expect(licenceProblem('E_COMMAND_FAILED')).toBe('Something went wrong. (E_COMMAND_FAILED)')
  })
})

describe('a devot://license link', () => {
  it('adds a license to a device that holds none', () => {
    expect(planLicenceLink(none, offer)).toEqual({ kind: 'add' })
  })

  it('changes nothing for the license held already', () => {
    expect(planLicenceLink(held(), offer)).toEqual({ kind: 'same' })
    expect(planLicenceLink(held({ state: 'revoked' }), offer)).toEqual({ kind: 'same' })
  })

  it('asks before it replaces another license, or one that does not verify', () => {
    const other = { ...offer, id: OTHER_ID, licensee: 'someone@example.com' }
    expect(planLicenceLink(held(), other)).toEqual({
      kind: 'ask',
      message: 'Replace the license on this device?',
      detail: `This device holds the license for buyer@example.com (${ID}). The key in the link is for someone@example.com (${OTHER_ID}).`,
    })
    const invalid = { ...none, state: 'invalid', code: 'E_LICENCE_SIGNATURE' } as const
    expect(planLicenceLink(invalid, other)).toEqual({
      kind: 'ask',
      message: 'Replace the license on this device?',
      detail: `The license on this device could not be verified. The key in the link is for someone@example.com (${OTHER_ID}).`,
    })
    // A keychain that could not be read may hold a license: ask too.
    expect(planLicenceLink({ ...none, code: 'E_LICENCE_KEYCHAIN' }, other).kind).toBe('ask')
  })

  it('asks when the same license now names another licensee', () => {
    expect(planLicenceLink(held(), { ...offer, licensee: 'new@example.com' })).toMatchObject({
      kind: 'ask',
      message: 'Replace the license on this device?',
    })
  })
})

describe('the trial', () => {
  const running = (endsAt: number | null = END): LicenceSnapshot => ({
    ...none,
    trial: { state: 'running', endsAt, code: null },
  })

  it('is read from what Rust sends, and counts as ended when a gating build says nothing of it', () => {
    expect(readLicence(running())).toEqual(running())
    const { trial: _, ...withoutTrial } = running()
    expect(readLicence(withoutTrial)?.trial).toEqual({ state: 'ended', endsAt: null, code: null })
    expect(readLicence({ ...running(), trial: { state: 'forever' } })?.trial?.state).toBe('ended')
    expect(readLicence({ ...LICENCE_UNKNOWN, trial: { state: 'running' } })?.trial).toBeNull()
    expect(
      readLicence({ ...none, trial: { state: 'ended', endsAt: 'soon', code: 'a title' } })?.trial,
    ).toEqual({ state: 'ended', endsAt: null, code: null })
  })

  it('runs until its end, as this window sees the time', () => {
    expect(trialRunning(running(), END - 1)).toBe(true)
    expect(trialRunning(running(), END)).toBe(false)
    expect(trialRunning(none, END - HOUR)).toBe(false)
    expect(trialOver(running(), END)).toBe(true)
    expect(trialOver(running(), END - 1)).toBe(false)
    expect(trialOver(held(), END + HOUR)).toBe(false)
    expect(trialOver({ ...LICENCE_UNKNOWN }, END)).toBe(false)
  })

  it('says the time left in its largest unit', () => {
    expect(timeLeft(2 * 24 * HOUR + 5 * HOUR, 'en')).toBe('2 days')
    expect(timeLeft(5 * HOUR + 59 * 60_000, 'en')).toBe('5 hours')
    expect(timeLeft(40 * 60_000 + 30_000, 'en')).toBe('40 minutes')
    expect(timeLeft(10_000, 'en')).toBe('1 minute')
  })

  it('has a line in Settings > License unless a license unlocks Devot', () => {
    expect(trialSentence(running(), END - 30 * HOUR, 'en')).toMatch(
      /^Everything works, sync and AI included, until the trial ends on .+ \(1 day left\)\.$/,
    )
    expect(trialSentence(none, END, 'en')).toMatch(/^The trial has ended, so notes are read-only/)
    expect(
      trialSentence(
        { ...none, trial: { state: 'ended', endsAt: null, code: 'E_LICENCE_KEYCHAIN' } },
        END,
        'en',
      ),
    ).toMatch(/keychain \(E_LICENCE_KEYCHAIN\)/)
    expect(trialSentence(held(), END, 'en')).toBeNull()
    expect(trialSentence(LICENCE_UNKNOWN, END, 'en')).toBeNull()
  })

  it('reminds once in its last day, until it is dismissed for this trial', () => {
    expect(reminderDue(running(), END - 25 * HOUR, null)).toBe(false)
    expect(reminderDue(running(), END - 23 * HOUR, null)).toBe(true)
    expect(reminderDue(running(), END - 23 * HOUR, END)).toBe(false)
    expect(reminderDue(running(), END - 23 * HOUR, END - 1)).toBe(true)
    expect(reminderDue(running(), END, null)).toBe(false)
    expect(reminderDue({ ...held(), trial: running().trial }, END - HOUR, null)).toBe(false)
    expect(reminderDue(running(null), END - HOUR, null)).toBe(false)
  })

  it('says whether it ends today or tomorrow, at what time', () => {
    expect(reminderText(END, END - 20 * HOUR, 'en')).toMatch(
      /^Your Devot trial ends tomorrow at 2:00\sPM\. After that, notes are read-only/,
    )
    expect(reminderText(END, END - 2 * HOUR, 'en')).toMatch(/ends today at 2:00\sPM/)
  })
})
