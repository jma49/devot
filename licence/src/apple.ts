/**
 * Apple's signed App Store data (docs/adr/0014-iphone-sold-on-the-app-store-with-the-licence-kept.md,
 * The licence exchange, step 2): a JWS signed ES256 by the leaf of an `x5c` chain of three
 * certificates that ends in Apple Root CA - G3, held here. Nothing in the JWS is trusted until the
 * chain and the signature check out.
 */
import { children, DerError, expect, oidOf, readOnly, TAG, timeOf, type Tlv } from './der.ts'
import { fromBase64Url } from './format.ts'

/** Apple Root CA - G3, from https://www.apple.com/certificateauthority/, SHA-256 63343abf…3e9179. */
export const APPLE_ROOT_CA_G3 = fromStandardBase64(
  'MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYD' +
    'VQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN' +
    'MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFw' +
    'cGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49' +
    'AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA' +
    '/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr' +
    'MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZL' +
    'uN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM' +
    '6BgD56KyKA==',
)

/** On the leaf: Mac App Store and iTunes Store Receipt Signing. */
export const LEAF_OID = '1.2.840.113635.100.6.11.1'
/** On the intermediate: Apple Worldwide Developer Relations. */
export const INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1'
const BASIC_CONSTRAINTS = '2.5.29.19'
const EC_PUBLIC_KEY = '1.2.840.10045.2.1'
const CURVES: Record<string, { name: 'P-256' | 'P-384'; size: number }> = {
  '1.2.840.10045.3.1.7': { name: 'P-256', size: 32 },
  '1.3.132.0.34': { name: 'P-384', size: 48 },
}
const SIGNATURE_HASHES: Record<string, 'SHA-256' | 'SHA-384'> = {
  '1.2.840.10045.4.3.2': 'SHA-256',
  '1.2.840.10045.4.3.3': 'SHA-384',
}
/** Far over any JWS Apple signs, so a huge body costs one length check. */
const MAX_JWS = 16 * 1024

export interface Certificate {
  bytes: Uint8Array
  tbs: Uint8Array
  signatureHash: 'SHA-256' | 'SHA-384'
  signature: Uint8Array
  issuer: Uint8Array
  subject: Uint8Array
  notBefore: number
  notAfter: number
  spki: Uint8Array
  curve: { name: 'P-256' | 'P-384'; size: number }
  extensions: Map<string, Uint8Array>
}

export function fromStandardBase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw new DerError()
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
}

export function parseCertificate(bytes: Uint8Array): Certificate {
  const [tbsTlv, algorithm, signatureValue, ...rest] = children(readOnly(bytes, TAG.sequence))
  if (rest.length > 0) throw new DerError()
  const tbs = expect(tbsTlv, TAG.sequence)
  const fields = children(tbs)
  let at = 0
  if (fields[0]?.tag === 0xa0) at++
  expect(fields[at++], TAG.integer)
  const innerAlgorithm = expect(fields[at++], TAG.sequence)
  const issuer = expect(fields[at++], TAG.sequence)
  const [notBefore, notAfter] = children(expect(fields[at++], TAG.sequence))
  const subject = expect(fields[at++], TAG.sequence)
  const spki = expect(fields[at++], TAG.sequence)
  const extensions = new Map<string, Uint8Array>()
  for (const field of fields.slice(at)) {
    if (field.tag !== 0xa3) continue
    const [list] = children(field)
    for (const extension of children(expect(list, TAG.sequence))) {
      const parts = children(extension)
      const value = parts.at(-1)
      const oid = oidOf(parts[0])
      if (extensions.has(oid)) throw new DerError()
      extensions.set(oid, expect(value, TAG.octetString).content)
    }
  }
  const outer = expect(algorithm, TAG.sequence)
  if (!equalBytes(outer.bytes, innerAlgorithm.bytes)) throw new DerError()
  const signatureHash = SIGNATURE_HASHES[oidOf(children(outer)[0])]
  if (!signatureHash) throw new DerError()
  const [keyAlgorithm] = children(spki)
  const [keyType, curveOid] = children(expect(keyAlgorithm, TAG.sequence))
  if (oidOf(keyType) !== EC_PUBLIC_KEY) throw new DerError()
  const curve = CURVES[oidOf(curveOid)]
  if (!curve) throw new DerError()
  return {
    bytes,
    tbs: tbs.bytes,
    signatureHash,
    signature: bitString(signatureValue),
    issuer: issuer.bytes,
    subject: subject.bytes,
    notBefore: timeOf(notBefore),
    notAfter: timeOf(notAfter),
    spki: spki.bytes,
    curve,
    extensions,
  }
}

function bitString(tlv: Tlv | undefined): Uint8Array {
  const content = expect(tlv, TAG.bitString).content
  if (content[0] !== 0) throw new DerError()
  return content.subarray(1)
}

function isCa(certificate: Certificate): boolean {
  const value = certificate.extensions.get(BASIC_CONSTRAINTS)
  if (!value) return false
  const [flag] = children(readOnly(value, TAG.sequence))
  return flag?.tag === TAG.boolean && flag.content.length === 1 && flag.content[0] === 0xff
}

/** An X.509 ECDSA signature, a DER SEQUENCE of r and s, as WebCrypto's fixed-size r || s. */
function rawSignature(der: Uint8Array, size: number): Uint8Array {
  const parts = children(readOnly(der, TAG.sequence))
  if (parts.length !== 2) throw new DerError()
  const out = new Uint8Array(size * 2)
  parts.forEach((part, i) => {
    let value = expect(part, TAG.integer).content
    while (value.length > 1 && value[0] === 0) value = value.subarray(1)
    if (value.length > size) throw new DerError()
    out.set(value, (i + 1) * size - value.length)
  })
  return out
}

function importKey(certificate: Certificate): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    certificate.spki as BufferSource,
    { name: 'ECDSA', namedCurve: certificate.curve.name },
    false,
    ['verify'],
  )
}

/** Whether `parent` issued and signed `child`. */
export async function signedBy(child: Certificate, parent: Certificate): Promise<boolean> {
  if (!equalBytes(child.issuer, parent.subject)) return false
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: child.signatureHash },
    await importKey(parent),
    rawSignature(child.signature, parent.curve.size) as BufferSource,
    child.tbs as BufferSource,
  )
}

const validAt = (chain: Certificate[], at: number) =>
  Number.isFinite(at) && chain.every((c) => c.notBefore <= at && at <= c.notAfter)

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

function json(part: string | undefined): Record<string, unknown> | null {
  const bytes = fromBase64Url(part ?? '')
  if (!bytes) return null
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    )
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * The payload of a JWS Apple signed, or null. `root` is Apple Root CA - G3 outside tests. Every
 * certificate must be valid at the payload's `signedDate` or at `now`: StoreKit may hand over a
 * transaction signed long ago, and the exchange asks Apple for the current one anyway.
 */
export async function verifyAppleJws(
  jws: unknown,
  now: Date,
  root: Uint8Array = APPLE_ROOT_CA_G3,
): Promise<Record<string, unknown> | null> {
  if (typeof jws !== 'string' || jws.length > MAX_JWS) return null
  const parts = jws.split('.')
  if (parts.length !== 3) return null
  const header = json(parts[0])
  const payload = json(parts[1])
  const signature = fromBase64Url(parts[2] ?? '')
  if (!header || !payload || signature?.length !== 64 || header['alg'] !== 'ES256') return null
  const x5c = header['x5c']
  if (!Array.isArray(x5c) || x5c.length !== 3 || !x5c.every((c) => typeof c === 'string')) {
    return null
  }
  try {
    const [leaf, intermediate, top] = (x5c as string[]).map((c) =>
      parseCertificate(fromStandardBase64(c)),
    )
    if (!leaf || !intermediate || !top || !equalBytes(top.bytes, root)) return null
    const anchor = parseCertificate(root)
    if (!leaf.extensions.has(LEAF_OID) || !intermediate.extensions.has(INTERMEDIATE_OID)) {
      return null
    }
    if (!isCa(intermediate) || isCa(leaf) || leaf.curve.name !== 'P-256') return null
    if (!(await signedBy(intermediate, anchor)) || !(await signedBy(leaf, intermediate))) {
      return null
    }
    const chain = [leaf, intermediate, anchor]
    const signedDate = payload['signedDate']
    const signedAt = typeof signedDate === 'number' ? signedDate : Number.NaN
    if (!validAt(chain, signedAt) && !validAt(chain, now.getTime())) return null
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await importKey(leaf),
      signature as BufferSource,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`) as BufferSource,
    )
    return valid ? payload : null
  } catch {
    // Malformed DER, or a key WebCrypto will not import: refused, never trusted.
    return null
  }
}
