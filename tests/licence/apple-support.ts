import { INTERMEDIATE_OID, LEAF_OID } from '../../licence/src/apple'
import { toBase64Url } from '../../licence/src/format'

// Certificate chains shaped like Apple's (a P-384 root and intermediate, a P-256 leaf, Apple's
// OIDs), made here with fresh keys, and the JWS they sign. Never Apple's keys, never the network.

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function lengthBytes(n: number): number[] {
  if (n < 0x80) return [n]
  const bytes: number[] = []
  for (let x = n; x > 0; x = Math.floor(x / 256)) bytes.unshift(x & 0xff)
  return [0x80 | bytes.length, ...bytes]
}

export const tlv = (tag: number, ...parts: Uint8Array[]) => {
  const body = concat(parts)
  return concat([Uint8Array.from([tag, ...lengthBytes(body.length)]), body])
}
const seq = (...parts: Uint8Array[]) => tlv(0x30, ...parts)
const set = (...parts: Uint8Array[]) => tlv(0x31, ...parts)
const utf8 = (text: string) => new TextEncoder().encode(text)

function unsigned(bytes: Uint8Array): Uint8Array {
  let at = 0
  while (at < bytes.length - 1 && bytes[at] === 0) at++
  const value = bytes.subarray(at)
  return value[0]! & 0x80 ? concat([Uint8Array.of(0), value]) : value
}

export function oid(dotted: string): Uint8Array {
  const [a = 0, b = 0, ...rest] = dotted.split('.').map(Number)
  const out = [40 * a + b]
  for (const value of rest) {
    const chunk = [value & 0x7f]
    for (let x = Math.floor(value / 128); x > 0; x = Math.floor(x / 128)) {
      chunk.unshift((x & 0x7f) | 0x80)
    }
    out.push(...chunk)
  }
  return tlv(0x06, Uint8Array.from(out))
}

function time(ms: number): Uint8Array {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const rest = `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  const year = d.getUTCFullYear()
  return year < 2050
    ? tlv(0x17, utf8(`${pad(year % 100)}${rest}`))
    : tlv(0x18, utf8(`${year}${rest}`))
}

const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, utf8(cn)))))
const extension = (id: string, value: Uint8Array, critical = false) =>
  seq(oid(id), ...(critical ? [tlv(0x01, Uint8Array.of(0xff))] : []), tlv(0x04, value))
const basicConstraints = (ca: boolean) =>
  extension('2.5.29.19', ca ? seq(tlv(0x01, Uint8Array.of(0xff))) : seq(), true)
const marker = (id: string) => extension(id, tlv(0x05))

const ALGORITHMS = {
  'SHA-256': seq(oid('1.2.840.10045.4.3.2')),
  'SHA-384': seq(oid('1.2.840.10045.4.3.3')),
}

export interface Party {
  keys: CryptoKeyPair
  curve: 'P-256' | 'P-384'
  name: string
  der: Uint8Array
}

export function newKeys(curve: 'P-256' | 'P-384'): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, [
    'sign',
    'verify',
  ]) as Promise<CryptoKeyPair>
}

/** An ECDSA signature as X.509 writes it: a DER SEQUENCE of r and s. */
export async function derSignature(
  key: CryptoKey,
  hash: 'SHA-256' | 'SHA-384',
  data: Uint8Array,
): Promise<Uint8Array> {
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash }, key, data as BufferSource),
  )
  const half = raw.length / 2
  return seq(tlv(0x02, unsigned(raw.subarray(0, half))), tlv(0x02, unsigned(raw.subarray(half))))
}

export interface CertOptions {
  name: string
  curve: 'P-256' | 'P-384'
  issuer?: Party
  notBefore?: number
  notAfter?: number
  ca?: boolean
  oids?: string[]
  /** Signs with this key instead of the issuer's: a forgery under the issuer's name. */
  signWith?: CryptoKey
  keys?: CryptoKeyPair
}

const YEAR = 365 * 86_400_000
export const CHAIN_FROM = Date.UTC(2020, 0, 1)

export async function certificate(options: CertOptions): Promise<Party> {
  const keys = options.keys ?? (await newKeys(options.curve))
  const issuerCurve = options.issuer?.curve ?? options.curve
  const hash = issuerCurve === 'P-384' ? 'SHA-384' : 'SHA-256'
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey))
  const extensions = [
    basicConstraints(options.ca ?? false),
    ...(options.oids ?? []).map((id) => marker(id)),
  ]
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Uint8Array.of(2))),
    tlv(0x02, Uint8Array.of(1 + Math.floor(Math.random() * 100))),
    ALGORITHMS[hash],
    name(options.issuer?.name ?? options.name),
    seq(time(options.notBefore ?? CHAIN_FROM), time(options.notAfter ?? CHAIN_FROM + 20 * YEAR)),
    name(options.name),
    spki,
    tlv(0xa3, seq(...extensions)),
  )
  const signer = options.signWith ?? options.issuer?.keys.privateKey ?? keys.privateKey
  const signature = await derSignature(signer, hash, tbs)
  const der = seq(tbs, ALGORITHMS[hash], tlv(0x03, concat([Uint8Array.of(0), signature])))
  return { keys, curve: options.curve, name: options.name, der }
}

export interface Chain {
  root: Party
  intermediate: Party
  leaf: Party
}

export async function chain(
  tweak: { intermediate?: Partial<CertOptions>; leaf?: Partial<CertOptions>; root?: Party } = {},
): Promise<Chain> {
  const root =
    tweak.root ?? (await certificate({ name: 'Test Root CA - G3', curve: 'P-384', ca: true }))
  const intermediate = await certificate({
    name: 'Test WWDR - G6',
    curve: 'P-384',
    issuer: root,
    ca: true,
    oids: [INTERMEDIATE_OID],
    ...tweak.intermediate,
  })
  const leaf = await certificate({
    name: 'Test Receipt Signing',
    curve: 'P-256',
    issuer: intermediate,
    oids: [LEAF_OID],
    ...tweak.leaf,
  })
  return { root, intermediate, leaf }
}

const standard = (der: Uint8Array) => Buffer.from(der).toString('base64')

export interface JwsOptions {
  header?: Record<string, unknown>
  x5c?: Uint8Array[]
  signWith?: CryptoKey
}

/** A JWS as the App Store signs one: ES256 by the leaf, the chain in `x5c`. */
export async function signJws(
  payload: Record<string, unknown>,
  by: Chain,
  options: JwsOptions = {},
): Promise<string> {
  const x5c = (options.x5c ?? [by.leaf.der, by.intermediate.der, by.root.der]).map(standard)
  const encode = (value: object) => toBase64Url(utf8(JSON.stringify(value)))
  const signed = `${encode({ alg: 'ES256', x5c, ...options.header })}.${encode(payload)}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    options.signWith ?? by.leaf.keys.privateKey,
    utf8(signed),
  )
  return `${signed}.${toBase64Url(new Uint8Array(signature))}`
}

export const BUNDLE = 'io.github.jma49.devot'
export const PRO = 'io.github.jma49.devot.pro'
export const TRIAL = 'io.github.jma49.devot.trial'

/** A JWSTransactionDecodedPayload for Devot Pro, bought, as Apple writes one. */
export function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionId: '2000000123456789',
    originalTransactionId: '2000000123456789',
    bundleId: BUNDLE,
    productId: PRO,
    purchaseDate: Date.UTC(2026, 10, 1),
    originalPurchaseDate: Date.UTC(2026, 10, 1),
    quantity: 1,
    type: 'Non-Consumable',
    inAppOwnershipType: 'PURCHASED',
    signedDate: Date.UTC(2026, 10, 2),
    environment: 'Production',
    transactionReason: 'PURCHASE',
    storefront: 'USA',
    ...overrides,
  }
}

/** The In-App Purchase key as App Store Connect gives it: a P-256 key in a PKCS #8 `.p8`. */
export async function inAppPurchaseKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const keys = await newKeys('P-256')
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey))
  const body = standard(pkcs8).replace(/(.{64})/g, '$1\n')
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
    publicKey: keys.publicKey,
  }
}
