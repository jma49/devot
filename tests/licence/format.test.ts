import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  fromBase64Url,
  instant,
  LICENCE_ID,
  newLicenceId,
  signerFromSeed,
  signLicence,
  toBase64Url,
  verifyLicence,
  verifyRevocations,
} from '../../licence/src/format'
import { generateKeyPair } from '../../licence/scripts/keygen'
import { buildTestVectors } from '../../licence/scripts/test-vectors'
import { vectors } from './support'

const publicKeys = Object.fromEntries(
  vectors.keys.map((k) => [k.kid, fromBase64Url(k.publicKey) ?? new Uint8Array()]),
)

describe('the shared test vectors', () => {
  it('are what the format produces from their fixed seeds', async () => {
    const committed = JSON.parse(readFileSync('licence/test-vectors.json', 'utf8'))
    expect(committed).toEqual(await buildTestVectors())
  })

  it('verify every valid key to its payload, field order included', async () => {
    const results = await Promise.all(
      vectors.licences.map(async (licence) => ({
        name: licence.name,
        result: await verifyLicence(licence.key, publicKeys),
        json: new TextDecoder().decode(
          fromBase64Url(licence.key.split('.')[1] ?? '') ?? new Uint8Array(),
        ),
      })),
    )
    expect(results).toEqual(
      vectors.licences.map((licence) => ({
        name: licence.name,
        result: { ok: true, payload: licence.payload },
        json: JSON.stringify(licence.payload),
      })),
    )
  })

  it('refuse every invalid key with its code', async () => {
    const results = await Promise.all(
      vectors.invalid.map(async (invalid) => ({
        name: invalid.name,
        result: await verifyLicence(invalid.key, publicKeys),
      })),
    )
    expect(results).toEqual(
      vectors.invalid.map((invalid) => ({
        name: invalid.name,
        result: { ok: false, code: invalid.code },
      })),
    )
  })

  it('verify the revocation list and refuse a tampered one', async () => {
    const { revocations } = vectors
    expect(await verifyRevocations(revocations.list, publicKeys)).toEqual({
      ok: true,
      payload: revocations.payload,
    })
    expect(await verifyRevocations(revocations.tampered.list, publicKeys)).toEqual({
      ok: false,
      code: revocations.tampered.code,
    })
    expect(await verifyRevocations(revocations.licenceAsList.list, publicKeys)).toEqual({
      ok: false,
      code: revocations.licenceAsList.code,
    })
    expect(revocations.payload.ids).toContain(vectors.licences[2]?.payload.id)
  })
})

describe('licence keys', () => {
  it('stay short enough for an email, a deep link and a paste', async () => {
    const signer = await signerFromSeed('2026-10', new Uint8Array(32).fill(7))
    const key = await signLicence(signer, {
      id: newLicenceId(),
      licensee: 'someone.with.a.longer.name@example.com',
      issuedAt: instant(new Date('2026-10-24T10:00:00.123Z')),
      updatesUntil: '2027-10-24',
    })
    expect(key.length).toBeLessThan(360)
    expect(key).toMatch(/^devot1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/)
  })

  it('carry 128 random bits as their ID', () => {
    const ids = new Set(Array.from({ length: 100 }, newLicenceId))
    expect(ids.size).toBe(100)
    for (const id of ids) {
      expect(id).toMatch(LICENCE_ID)
      expect(fromBase64Url(id)?.length).toBe(16)
    }
  })

  it('give issuedAt in UTC to the second', () => {
    expect(instant(new Date('2026-10-24T10:00:00.999Z'))).toBe('2026-10-24T10:00:00Z')
  })

  it('refuse a key whose payload is not the documented shape', async () => {
    const signer = await signerFromSeed('test', fromBase64Url(vectors.keys[0]?.seed ?? '')!)
    const signed = await signLicence(signer, {
      id: 'short',
      licensee: 'a@example.com',
      issuedAt: '2026-10-24T09:30:00Z',
      updatesUntil: '2027-10-24',
    })
    expect(await verifyLicence(signed, publicKeys)).toEqual({
      ok: false,
      code: 'E_LICENCE_MALFORMED',
    })
    expect(await verifyLicence('x'.repeat(5000), publicKeys)).toMatchObject({
      code: 'E_LICENCE_MALFORMED',
    })
  })
})

describe('base64url', () => {
  it('round-trips and refuses padding or non-canonical text', () => {
    const bytes = new Uint8Array([251, 255, 0, 1, 2])
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes)
    expect(toBase64Url(bytes)).not.toMatch(/[+/=]/)
    expect(fromBase64Url('AQ==')).toBeNull()
    expect(fromBase64Url('AR')).toBeNull()
    expect(fromBase64Url('a+b/')).toBeNull()
  })
})

it('keygen prints a pair whose seed signs what its public key verifies', async () => {
  const pair = await generateKeyPair()
  expect(fromBase64Url(pair.seed)?.length).toBe(32)
  const signer = await signerFromSeed('new', fromBase64Url(pair.seed)!)
  const key = await signLicence(signer, {
    id: newLicenceId(),
    licensee: 'a@example.com',
    issuedAt: '2026-10-24T09:30:00Z',
    updatesUntil: '2027-10-24',
  })
  const result = await verifyLicence(key, { new: fromBase64Url(pair.publicKey)! })
  expect(result.ok).toBe(true)
})
