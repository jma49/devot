import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  APPLE_ROOT_CA_G3,
  fromStandardBase64,
  INTERMEDIATE_OID,
  LEAF_OID,
  parseCertificate,
  signedBy,
  verifyAppleJws,
} from '../../licence/src/apple'
import {
  certificate,
  chain,
  type Chain,
  CHAIN_FROM,
  newKeys,
  signJws,
  transaction,
} from './apple-support'

// The App Store's JWS and its x5c chain, checked with chains made in the test whose root is passed
// in place of Apple's; Apple's own root stays pinned in the source.

/** Apple Worldwide Developer Relations - G6, as https://www.apple.com/certificateauthority/ serves it. */
const APPLE_WWDR_G6 =
  'MIIDFjCCApygAwIBAgIUIsGhRwp0c2nvU4YSycafPTjzbNcwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBD' +
  'QSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkG' +
  'A1UEBhMCVVMwHhcNMjEwMzE3MjAzNzEwWhcNMzYwMzE5MDAwMDAwWjB1MUQwQgYDVQQDDDtBcHBsZSBXb3JsZHdpZGUgRGV2' +
  'ZWxvcGVyIFJlbGF0aW9ucyBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTELMAkGA1UECwwCRzYxEzARBgNVBAoMCkFwcGxlIElu' +
  'Yy4xCzAJBgNVBAYTAlVTMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEbsQKC94PrlWmZXnXgtxzdVJL8T0SGYngDRGpngn3N6PT' +
  '8JMEb7FDi4bBmPhCnZ3/sq6PF/cGcKXWsL5vOteRhyJ45x3ASP7cOB+aao90fcpxSv/EZFbniAbNgZGhIhpIo4H6MIH3MBIG' +
  'A1UdEwEB/wQIMAYBAf8CAQAwHwYDVR0jBBgwFoAUu7DeoVgziJqkipnevr3rr9rLJKswRgYIKwYBBQUHAQEEOjA4MDYGCCsG' +
  'AQUFBzABhipodHRwOi8vb2NzcC5hcHBsZS5jb20vb2NzcDAzLWFwcGxlcm9vdGNhZzMwNwYDVR0fBDAwLjAsoCqgKIYmaHR0' +
  'cDovL2NybC5hcHBsZS5jb20vYXBwbGVyb290Y2FnMy5jcmwwHQYDVR0OBBYEFD8vlCNR01DJmig97bB85c+lkGKZMA4GA1Ud' +
  'DwEB/wQEAwIBBjAQBgoqhkiG92NkBgIBBAIFADAKBggqhkjOPQQDAwNoADBlAjBAXhSq5IyKogMCPtw490BaB677CaEGJXuf' +
  'QB/EqZGd6CSjiCtOnuMTbXVXmxxcxfkCMQDTSPxarZXvNrkxU3TkUMI33yzvFVVRT4wxWJC994OsdcZ4+RGNsYDyR5gmdr0n' +
  'DGg='

const NOW = new Date(Date.UTC(2026, 10, 5))
let good: Chain
beforeAll(async () => {
  good = await chain()
})

const verify = (jws: unknown, root = good.root.der, now = NOW) => verifyAppleJws(jws, now, root)

describe("Apple's pinned certificates", () => {
  it('pins Apple Root CA - G3 by its published SHA-256 fingerprint', () => {
    expect(createHash('sha256').update(APPLE_ROOT_CA_G3).digest('hex')).toBe(
      '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179',
    )
    const root = parseCertificate(APPLE_ROOT_CA_G3)
    expect(root.curve.name).toBe('P-384')
    expect(new TextDecoder().decode(root.subject)).toContain('Apple Root CA - G3')
  })

  it("verifies Apple's real WWDR G6 intermediate against the pinned root, with Apple's OID", async () => {
    const root = parseCertificate(APPLE_ROOT_CA_G3)
    const wwdr = parseCertificate(fromStandardBase64(APPLE_WWDR_G6))
    expect(await signedBy(wwdr, root)).toBe(true)
    expect(await signedBy(root, root)).toBe(true)
    expect(wwdr.extensions.has(INTERMEDIATE_OID)).toBe(true)
    const tampered = parseCertificate(fromStandardBase64(APPLE_WWDR_G6))
    const at = tampered.tbs.length - 40
    tampered.tbs[at] = (tampered.tbs[at] ?? 0) ^ 1
    expect(await signedBy(tampered, root)).toBe(false)
  })
})

describe('a JWS the App Store signed', () => {
  it('is accepted with its chain, and its payload returned', async () => {
    const payload = transaction()
    expect(await verify(await signJws(payload, good))).toEqual(payload)
  })

  it("is refused under Apple's pinned root when its chain ends in another root", async () => {
    expect(await verifyAppleJws(await signJws(transaction(), good), NOW)).toBeNull()
  })

  it('is refused when the x5c root is not the pinned one, even if the chain is consistent', async () => {
    const other = await chain()
    expect(await verify(await signJws(transaction(), other))).toBeNull()
    const swappedRoot = await signJws(transaction(), good, {
      x5c: [good.leaf.der, good.intermediate.der, other.root.der],
    })
    expect(await verify(swappedRoot)).toBeNull()
  })

  it('is refused with a forged signature, a changed payload or a changed header', async () => {
    const jws = await signJws(transaction(), good)
    const [header, payload, signature] = jws.split('.')
    const forged = await signJws(transaction(), good, {
      signWith: (await newKeys('P-256')).privateKey,
    })
    expect(await verify(forged)).toBeNull()
    const other = (await signJws(transaction({ productId: 'x' }), good)).split('.')[1]
    expect(await verify(`${header}.${other}.${signature}`)).toBeNull()
    const flipped = `${signature?.slice(0, -2)}${signature?.endsWith('A') ? 'B' : 'A'}${signature?.slice(-1)}`
    expect(await verify(`${header}.${payload}.${flipped}`)).toBeNull()
  })

  it('is refused unless it is ES256 with exactly three certificates', async () => {
    for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { alg: 'ES384' }]) {
      expect(await verify(await signJws(transaction(), good, { header }))).toBeNull()
    }
    const two = await signJws(transaction(), good, { x5c: [good.leaf.der, good.intermediate.der] })
    expect(await verify(two)).toBeNull()
    const four = await signJws(transaction(), good, {
      x5c: [good.leaf.der, good.intermediate.der, good.root.der, good.root.der],
    })
    expect(await verify(four)).toBeNull()
    const noChain = await signJws(transaction(), good, { header: { x5c: undefined } })
    expect(await verify(noChain)).toBeNull()
  })

  it("is refused when the leaf or the intermediate lacks Apple's OID", async () => {
    const noLeafOid = await chain({ root: good.root, leaf: { oids: [] } })
    expect(await verify(await signJws(transaction(), noLeafOid))).toBeNull()
    const swapped = await chain({ root: good.root, leaf: { oids: [INTERMEDIATE_OID] } })
    expect(await verify(await signJws(transaction(), swapped))).toBeNull()
    const noIntermediateOid = await chain({ root: good.root, intermediate: { oids: [] } })
    expect(await verify(await signJws(transaction(), noIntermediateOid))).toBeNull()
    const leafOidOnIntermediate = await chain({
      root: good.root,
      intermediate: { oids: [LEAF_OID] },
    })
    expect(await verify(await signJws(transaction(), leafOidOnIntermediate))).toBeNull()
  })

  it('is refused when a certificate is forged under its issuer name', async () => {
    const stranger = await newKeys('P-384')
    const forgedIntermediate = await chain({
      root: good.root,
      intermediate: { signWith: stranger.privateKey },
    })
    expect(await verify(await signJws(transaction(), forgedIntermediate))).toBeNull()
    const forgedLeaf = await chain({
      root: good.root,
      leaf: { signWith: stranger.privateKey },
    })
    expect(await verify(await signJws(transaction(), forgedLeaf))).toBeNull()
  })

  it('is refused when the intermediate is no CA, or the leaf is one or is not P-256', async () => {
    const notCa = await chain({ root: good.root, intermediate: { ca: false } })
    expect(await verify(await signJws(transaction(), notCa))).toBeNull()
    const caLeaf = await chain({ root: good.root, leaf: { ca: true } })
    expect(await verify(await signJws(transaction(), caLeaf))).toBeNull()
    const keys = await newKeys('P-384')
    const bigLeaf = await chain({ root: good.root, leaf: { curve: 'P-384', keys } })
    expect(
      await verify(await signJws(transaction(), bigLeaf, { signWith: keys.privateKey })),
    ).toBeNull()
  })

  it('takes a chain valid at its signedDate or now, and refuses one valid at neither', async () => {
    const expired = await chain({
      root: good.root,
      leaf: { notBefore: CHAIN_FROM, notAfter: Date.UTC(2026, 0, 1) },
    })
    const old = transaction({ signedDate: Date.UTC(2025, 5, 1) })
    expect(await verify(await signJws(old, expired))).toEqual(old)
    expect(await verify(await signJws(transaction(), expired))).toBeNull()
    expect(await verify(await signJws(transaction({ signedDate: 'soon' }), expired))).toBeNull()
    const later = await chain({
      root: good.root,
      leaf: { notBefore: Date.UTC(2026, 9, 1), notAfter: Date.UTC(2027, 0, 1) },
    })
    const signedBefore = transaction({ signedDate: Date.UTC(2025, 0, 1) })
    expect(await verify(await signJws(signedBefore, later))).toEqual(signedBefore)
    expect(
      await verify(
        await signJws(signedBefore, later),
        good.root.der,
        new Date(Date.UTC(2028, 0, 1)),
      ),
    ).toBeNull()
  })

  it('is refused when malformed, not a string or over 16 KB', async () => {
    for (const value of [undefined, 42, '', 'a.b', 'a.b.c', '...', `${'a'.repeat(17_000)}.b.c`]) {
      expect(await verify(value)).toBeNull()
    }
    const big = await signJws(transaction({ padding: 'x'.repeat(16 * 1024) }), good)
    expect(await verify(big)).toBeNull()
    const garbage = await signJws(transaction(), good, {
      x5c: [Uint8Array.of(0x30, 0x03, 0x02, 0x01), good.intermediate.der, good.root.der],
    })
    expect(await verify(garbage)).toBeNull()
  })

  it('takes a larger size limit when the caller gives one, and refuses past it', async () => {
    const notification = await signJws(transaction({ padding: 'x'.repeat(20 * 1024) }), good)
    expect(await verify(notification)).toBeNull()
    expect(await verifyAppleJws(notification, NOW, good.root.der, 64 * 1024)).toMatchObject({
      transactionId: '2000000123456789',
    })
    const huge = await signJws(transaction({ padding: 'x'.repeat(64 * 1024) }), good)
    expect(await verifyAppleJws(huge, NOW, good.root.der, 64 * 1024)).toBeNull()
  })

  it('reads certificates with long lengths and both time forms', async () => {
    const far = await certificate({
      name: 'Far',
      curve: 'P-384',
      ca: true,
      notAfter: Date.UTC(2060, 0, 1),
    })
    const parsed = parseCertificate(far.der)
    expect(parsed.notAfter).toBe(Date.UTC(2060, 0, 1))
    expect(parsed.notBefore).toBe(CHAIN_FROM)
  })
})
