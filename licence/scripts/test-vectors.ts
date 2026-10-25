import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  type Signer,
  fromBase64Url,
  LICENCE_PREFIX,
  publicKeyFromSeed,
  signerFromSeed,
  signLicence,
  signRevocations,
  toBase64Url,
} from '../src/format.ts'

// Test-only keys from fixed seeds, so the file is the same on every run. Never sign a real licence
// with them. `pnpm --filter @devot/licence test-vectors` writes licence/test-vectors.json again.

const OUT = fileURLToPath(new URL('../test-vectors.json', import.meta.url))

async function seed(label: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(label)))
}

function decode(part: string): object {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(part) ?? new Uint8Array()))
}

function asPayload(fields: { id: string; licensee: string; issuedAt: string }) {
  const { id, licensee, issuedAt } = fields
  return { id, kid: 'test', plan: 'pro', licensee, issuedAt }
}

/** Signs a payload as given, so a vector can carry fields `signLicence` never writes. */
async function signPayload(signer: Signer, payload: object): Promise<string> {
  const signed = `${LICENCE_PREFIX}.${toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}`
  return `${signed}.${toBase64Url(await signer.sign(new TextEncoder().encode(signed)))}`
}

async function licenceId(label: string): Promise<string> {
  return toBase64Url((await seed(label)).slice(0, 16))
}

export async function buildTestVectors() {
  const testSeed = await seed('devot licence test vectors: test key')
  const otherSeed = await seed('devot licence test vectors: other key')
  const signer = await signerFromSeed('test', testSeed)
  const other = await signerFromSeed('test', otherSeed)
  const retired: Signer = { kid: 'retired', sign: signer.sign }
  const first = await licenceId('devot licence test vectors: licence 1')
  const second = await licenceId('devot licence test vectors: licence 2')
  const bought = {
    id: first,
    licensee: 'buyer@example.com',
    issuedAt: '2026-10-24T09:30:00Z',
  }
  const unicode = {
    id: second,
    licensee: 'jörg.müller@example.com',
    issuedAt: '2026-02-28T23:59:59Z',
  }
  const later = { ...asPayload(bought), seats: 3 }
  const valid = await signLicence(signer, bought)
  const [, payload, signature] = valid.split('.')
  const tamperedPayload = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ ...decode(payload ?? ''), licensee: 'someone.else@example.com' }),
    ),
  )
  const revocations = { issuedAt: '2026-11-01T00:00:00Z', ids: [second] }
  const list = await signRevocations(signer, revocations)
  const listSignature = list.split('.')[2]
  const tamperedList = await signRevocations(signer, { ...revocations, ids: [] })
  return {
    note: 'Test-only keys from fixed seeds (docs/licensing.md, Formats). Never trust these keys in a release.',
    keys: [
      {
        kid: 'test',
        seed: toBase64Url(testSeed),
        publicKey: toBase64Url(await publicKeyFromSeed(testSeed)),
      },
    ],
    licences: [
      { name: 'bought', key: valid, payload: asPayload(bought) },
      {
        name: 'non-ASCII licensee',
        key: await signLicence(signer, unicode),
        payload: asPayload(unicode),
      },
      {
        name: 'a field this version does not know',
        key: await signPayload(signer, later),
        payload: later,
      },
    ],
    invalid: [
      {
        name: 'tampered payload',
        key: `${LICENCE_PREFIX}.${tamperedPayload}.${signature}`,
        code: 'E_LICENCE_SIGNATURE',
      },
      {
        name: 'signed by another key',
        key: await signLicence(other, bought),
        code: 'E_LICENCE_SIGNATURE',
      },
      {
        name: 'unknown kid',
        key: await signLicence(retired, bought),
        code: 'E_LICENCE_UNKNOWN_KID',
      },
      { name: 'wrong prefix', key: `devot2.${payload}.${signature}`, code: 'E_LICENCE_MALFORMED' },
      {
        name: 'missing signature',
        key: `${LICENCE_PREFIX}.${payload}`,
        code: 'E_LICENCE_MALFORMED',
      },
      { name: 'revocation list as a key', key: list, code: 'E_LICENCE_MALFORMED' },
    ],
    revocations: {
      list,
      payload: { kid: 'test', ...revocations },
      tampered: {
        list: `${tamperedList.split('.').slice(0, 2).join('.')}.${listSignature}`,
        code: 'E_LICENCE_SIGNATURE',
      },
      licenceAsList: { list: `devot1rev.${payload}.${signature}`, code: 'E_LICENCE_MALFORMED' },
    },
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(OUT, `${JSON.stringify(await buildTestVectors(), null, 2)}\n`)
}
