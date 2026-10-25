import { describe, expect, it } from 'vitest'
import { BUY_URL, LICENCE_UNKNOWN, readLicence, renewUrl, type LicenceSnapshot } from './licence'
import {
  licenceDate,
  licenceProblem,
  lockedText,
  planLicenceLink,
  renewable,
  stateSentence,
} from './licenceView'

const ID = '5vEvzHainWD0cA2Ht_ljHg'
const held = (over: Partial<LicenceSnapshot> = {}): LicenceSnapshot => ({
  gated: true,
  state: 'valid',
  code: null,
  id: ID,
  licensee: 'buyer@example.com',
  updatesUntil: '2027-10-24',
  plan: 'pro',
  ...over,
})
const none: LicenceSnapshot = { ...LICENCE_UNKNOWN, gated: true }
const offer = {
  id: ID,
  licensee: 'buyer@example.com',
  updatesUntil: '2027-10-24',
  state: 'valid',
} as const

describe('readLicence', () => {
  it('takes what Rust sends and nothing it would not', () => {
    expect(readLicence(held())).toEqual(held())
    expect(readLicence({ ...held(), id: 'short', updatesUntil: 'soon', plan: 'team' })).toEqual(
      held({ id: null, updatesUntil: null, plan: null }),
    )
    expect(readLicence({ ...held(), code: 'a note title' })?.code).toBeNull()
    expect(readLicence({ ...held(), state: 'great' })).toBeUndefined()
    expect(readLicence({ state: 'none' })).toBeUndefined()
    expect(readLicence(null)).toBeUndefined()
  })
})

describe('the licence pages', () => {
  it('live under one address', () => {
    expect(BUY_URL).toBe('https://licence.devot.online/buy')
    expect(renewUrl(ID)).toBe(`https://licence.devot.online/renew?licence=${ID}`)
  })
})

describe('what the windows say', () => {
  it('shows the last covered release as that UTC day', () => {
    expect(licenceDate('2027-10-24', 'en')).toBe('October 24, 2027')
    expect(licenceDate('2026-01-01', 'en')).toBe('January 1, 2026')
  })

  it('gives each state a sentence', () => {
    expect(stateSentence(none, 'en')).toMatch(/^No licence is added/)
    expect(stateSentence({ ...none, gated: false }, 'en')).toMatch(/does not check licences/)
    expect(stateSentence({ ...none, code: 'E_LICENCE_KEYCHAIN' }, 'en')).toMatch(
      /keychain \(E_LICENCE_KEYCHAIN\)/,
    )
    expect(stateSentence(held(), 'en')).toBe('Sync and AI are unlocked on this device.')
    expect(stateSentence(held({ state: 'updatesEnded' }), 'en')).toMatch(
      /released until October 24, 2027/,
    )
    expect(stateSentence(held({ state: 'revoked' }), 'en')).toMatch(/revoked/)
    expect(stateSentence({ ...none, state: 'invalid', code: 'E_LICENCE_SIGNATURE' }, 'en')).toMatch(
      /could not be verified \(E_LICENCE_SIGNATURE\)/,
    )
  })

  it('says why a key was refused', () => {
    expect(licenceProblem('E_LICENCE_MALFORMED')).toBe(
      'This is not a complete Devot licence key. (E_LICENCE_MALFORMED)',
    )
    expect(licenceProblem('E_LICENCE_UNKNOWN_KID')).toMatch(/Update Devot/)
    expect(licenceProblem('E_COMMAND_FAILED')).toBe('Something went wrong. (E_COMMAND_FAILED)')
  })

  it('offers Renew only for a licence that ended before this version', () => {
    expect(renewable(held({ state: 'updatesEnded' }))).toBe(true)
    expect(renewable(held({ state: 'updatesEnded', id: null }))).toBe(false)
    expect(renewable(held({ state: 'revoked' }))).toBe(false)
    expect(renewable(none)).toBe(false)
    expect(lockedText('sync', none, 'en')).toBe(
      'Sync needs a Devot licence. Add one in Settings > Licence.',
    )
    expect(lockedText('ai', none, 'en')).toMatch(/^AI needs/)
    expect(lockedText('ai', held({ state: 'updatesEnded' }), 'en')).toMatch(/until you renew it/)
  })
})

describe('a devot://licence link', () => {
  it('adds a licence to a device that holds none', () => {
    expect(planLicenceLink(none, offer, 'en')).toEqual({ kind: 'add' })
  })

  it('changes nothing for the licence held already', () => {
    expect(planLicenceLink(held(), offer, 'en')).toEqual({ kind: 'same' })
  })

  it('says when the key is the same licence renewed', () => {
    const plan = planLicenceLink(held({ updatesUntil: '2026-10-24' }), offer, 'en')
    expect(plan).toEqual({
      kind: 'ask',
      message: 'Add the renewed licence?',
      detail: `The key in the link is the licence this device holds (${ID}), renewed: updates until October 24, 2027 instead of October 24, 2026.`,
    })
  })

  it('asks before it replaces another licence, or one that does not verify', () => {
    const other = { ...offer, id: '3f4lHWhFWnUPeDt7yIa3rw', licensee: 'someone@example.com' }
    expect(planLicenceLink(held(), other, 'en')).toMatchObject({
      kind: 'ask',
      message: 'Replace the licence on this device?',
    })
    const invalid = { ...none, state: 'invalid', code: 'E_LICENCE_SIGNATURE' } as const
    expect(planLicenceLink(invalid, other, 'en')).toMatchObject({
      kind: 'ask',
      detail: expect.stringMatching(/could not be verified/),
    })
    // A keychain that could not be read may hold a licence: ask too.
    expect(planLicenceLink({ ...none, code: 'E_LICENCE_KEYCHAIN' }, other, 'en').kind).toBe('ask')
  })
})
