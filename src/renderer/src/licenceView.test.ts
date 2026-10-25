import { describe, expect, it } from 'vitest'
import { BUY_URL, LICENCE_UNKNOWN, readLicence, type LicenceSnapshot } from './licence'
import { licenceProblem, planLicenceLink, stateSentence } from './licenceView'

const ID = '5vEvzHainWD0cA2Ht_ljHg'
const OTHER_ID = '3f4lHWhFWnUPeDt7yIa3rw'
const held = (over: Partial<LicenceSnapshot> = {}): LicenceSnapshot => ({
  gated: true,
  state: 'valid',
  code: null,
  id: ID,
  licensee: 'buyer@example.com',
  plan: 'pro',
  ...over,
})
const none: LicenceSnapshot = { ...LICENCE_UNKNOWN, gated: true }
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

describe('the licence pages', () => {
  it('live under one address', () => {
    expect(BUY_URL).toBe('https://licence.devot.online/buy')
  })
})

describe('what the windows say', () => {
  it('gives each state a sentence', () => {
    expect(stateSentence(none)).toMatch(/^No licence is added/)
    expect(stateSentence({ ...none, gated: false })).toMatch(/does not check licences/)
    expect(stateSentence({ ...none, code: 'E_LICENCE_KEYCHAIN' })).toMatch(
      /keychain \(E_LICENCE_KEYCHAIN\)/,
    )
    expect(stateSentence(held())).toBe('Sync and AI are unlocked on this device.')
    expect(stateSentence(held({ state: 'revoked' }))).toMatch(/revoked/)
    expect(stateSentence({ ...none, state: 'invalid', code: 'E_LICENCE_SIGNATURE' })).toMatch(
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
})

describe('a devot://licence link', () => {
  it('adds a licence to a device that holds none', () => {
    expect(planLicenceLink(none, offer)).toEqual({ kind: 'add' })
  })

  it('changes nothing for the licence held already', () => {
    expect(planLicenceLink(held(), offer)).toEqual({ kind: 'same' })
    expect(planLicenceLink(held({ state: 'revoked' }), offer)).toEqual({ kind: 'same' })
  })

  it('asks before it replaces another licence, or one that does not verify', () => {
    const other = { ...offer, id: OTHER_ID, licensee: 'someone@example.com' }
    expect(planLicenceLink(held(), other)).toEqual({
      kind: 'ask',
      message: 'Replace the licence on this device?',
      detail: `This device holds the licence for buyer@example.com (${ID}). The key in the link is for someone@example.com (${OTHER_ID}).`,
    })
    const invalid = { ...none, state: 'invalid', code: 'E_LICENCE_SIGNATURE' } as const
    expect(planLicenceLink(invalid, other)).toEqual({
      kind: 'ask',
      message: 'Replace the licence on this device?',
      detail: `The licence on this device could not be verified. The key in the link is for someone@example.com (${OTHER_ID}).`,
    })
    // A keychain that could not be read may hold a licence: ask too.
    expect(planLicenceLink({ ...none, code: 'E_LICENCE_KEYCHAIN' }, other).kind).toBe('ask')
  })

  it('asks when the same licence now names another licensee', () => {
    expect(planLicenceLink(held(), { ...offer, licensee: 'new@example.com' })).toMatchObject({
      kind: 'ask',
      message: 'Replace the licence on this device?',
    })
  })
})
