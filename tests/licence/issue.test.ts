import { describe, expect, it } from 'vitest'
import { fromBase64Url, LICENCE_ID, verifyLicence } from '../../licence/src/format'
import { issue, main, yearAfter } from '../../licence/scripts/issue'
import { vectors } from './support'

// `issue` signs a complimentary licence locally from the seed in the environment; the test key
// stands in for the owner's.

const [testKey] = vectors.keys
const publicKeys = { [testKey!.kid]: fromBase64Url(testKey!.publicKey)! }
const env = { LICENCE_SIGNING_KEY: testKey!.seed, LICENCE_KID: testKey!.kid }
const NOW = new Date('2026-10-24T09:30:12.345Z')

describe('issue', () => {
  it('signs a licence the app verifies, for a year from today', async () => {
    const issued = await issue({
      seed: env.LICENCE_SIGNING_KEY,
      kid: 'test',
      licensee: 'friend@example.com',
      now: NOW,
    })
    expect(issued.id).toMatch(LICENCE_ID)
    expect(issued.updatesUntil).toBe('2027-10-24')
    expect(await verifyLicence(issued.key, publicKeys)).toEqual({
      ok: true,
      payload: {
        id: issued.id,
        kid: 'test',
        plan: 'pro',
        licensee: 'friend@example.com',
        issuedAt: '2026-10-24T09:30:12Z',
        updatesUntil: '2027-10-24',
      },
    })
  })

  it('counts a year as the Worker does', () => {
    expect(yearAfter(new Date('2028-02-29T12:00:00Z'))).toBe('2029-03-01')
    expect(yearAfter(new Date('2026-12-31T23:59:59Z'))).toBe('2027-12-31')
  })

  it('prints the key, its ID and the link, and never the seed', async () => {
    let out = ''
    let err = ''
    const status = await main(
      ['friend@example.com'],
      env,
      (t) => (out += t),
      (t) => (err += t),
      NOW,
    )
    expect(status).toBe(0)
    expect(err).toBe('')
    const key = out.match(/^Key: (devot1\.\S+)$/m)?.[1] ?? ''
    expect((await verifyLicence(key, publicKeys)).ok).toBe(true)
    expect(out).toMatch(/^Licence ID: [A-Za-z0-9_-]{22}$/m)
    expect(out).toContain('Updates until: 2027-10-24')
    expect(out).toContain(`devot://licence?key=${encodeURIComponent(key)}`)
    expect(out).not.toContain(env.LICENCE_SIGNING_KEY)
  })

  it('refuses without an address, a seed or a kid, by code alone', async () => {
    for (const [args, environment] of [
      [[], env],
      [['not an address'], env],
      [['a@example.com', 'b@example.com'], env],
      [['a@example.com'], { LICENCE_KID: 'test' }],
      [['a@example.com'], { LICENCE_SIGNING_KEY: env.LICENCE_SIGNING_KEY }],
      [['a@example.com'], { ...env, LICENCE_SIGNING_KEY: 'short' }],
    ] as const) {
      let out = ''
      let err = ''
      const status = await main(
        args,
        environment,
        (t) => (out += t),
        (t) => (err += t),
        NOW,
      )
      expect(status).toBe(2)
      expect(out).toBe('')
      expect(err).toMatch(/^E_LICENCE_(BAD_REQUEST|CONFIG)\n/)
      expect(err).not.toContain(env.LICENCE_SIGNING_KEY)
    }
  })
})
