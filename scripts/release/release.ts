// The release workflow's steps (.github/workflows/release.yml, docs/releasing.md):
//
//   node scripts/release/release.ts set-version <tag>
//     Checks the tag (vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-betaN) and
//     writes its version to package.json and src-tauri/Cargo.toml; Tauri
//     takes the app's version from Cargo. Prints the version and channel as
//     `version=…` and `channel=…` lines (for $GITHUB_OUTPUT).
//
//   node scripts/release/release.ts replaces-feed <tag> <current feed file> [<signature file>]
//     Prints `replace=true` when the release is newer than the feed's (or the file is empty or
//     missing), or when it is the feed's own version rebuilt with another signature;
//     `replace=false` otherwise.
//
//   node scripts/release/release.ts feeds <tag>
//     Prints the channel feeds the release goes in, one per line: `beta` for
//     a beta, `stable` and `beta` for a stable release, so a beta install is
//     offered the newest build of either kind.
//
//   node scripts/release/release.ts feed <tag> <url> <signature file> <notes file> <out file>
//     Writes the update feed for the release: what the app's updater reads
//     from a channel file in the `updater` release (beta.json until 1.0).
//
//   node scripts/release/release.ts sign <tag> <file> <out file>
//     Signs the updater bundle as `tauri build` would, with the secret key in
//     TAURI_SIGNING_PRIVATE_KEY (TAURI_SIGNING_PRIVATE_KEY_PASSWORD), and
//     records the release's version in the signature. Needs only Node, so the
//     key never reaches the build's dependencies.
//
//   node scripts/release/release.ts verify-signature <file> <signature file> <public key> [<tag>]
//     Checks that the signature is the file's, made with the secret key of
//     the public key the app is built with (the TAURI_UPDATER_PUBKEY
//     variable), so a release never ships an update no install would take;
//     with a tag, also that it records the tag's version.
//
// Errors carry a code and end the run with status 1.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  scryptSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Channel = 'stable' | 'beta'

// One digit: as a semver prerelease identifier `beta10` would sort before `beta2`.
const TAG = /^v(\d+)\.(\d+)\.(\d+)(-beta([1-9]))?$/
// Also accepts the pre-tag form with a dot (`0.9.0-beta.1`).
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-beta(?:([1-9])|\.(\d+)))?$/

export function versionFromTag(tag: string): string {
  const match = TAG.exec(tag)
  // No leading zeros: semver refuses them, and the updater compares semver.
  const parts = match?.slice(1, 4) ?? []
  if (!match || parts.some((n) => n.length > 1 && n.startsWith('0'))) {
    throw new Error(`E_RELEASE_TAG_INVALID: ${JSON.stringify(tag)}`)
  }
  return tag.slice(1)
}

/** Negative when `a` is older; also takes an older `-beta.N` version from a feed. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const match = VERSION.exec(v)
    if (!match) throw new Error(`E_RELEASE_VERSION_INVALID: ${JSON.stringify(v)}`)
    // A release comes after every beta of the same version.
    return [match[1], match[2], match[3], match[4] ?? match[5] ?? Infinity].map(Number)
  }
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1
  return 0
}

/**
 * Only a newer version replaces the feed, so a release finishing after a newer one never takes it
 * back. The same version rebuilt with another signature does replace it: a rerun signs a new
 * bundle, and a feed that kept the old signature would offer an update that never verifies.
 */
export function replacesFeed(version: string, feed: string, signature?: string): boolean {
  let data: { version?: unknown; platforms?: Record<string, { signature?: unknown }> }
  try {
    data = JSON.parse(feed) as typeof data
  } catch {
    return true
  }
  if (typeof data?.version !== 'string' || !VERSION.test(data.version)) return true
  const order = compareVersions(version, data.version)
  if (order !== 0) return order > 0
  if (signature === undefined) return false
  const kept = data.platforms?.['darwin-aarch64']?.signature
  return typeof kept !== 'string' || kept.trim() !== signature.trim()
}

export const channelOf = (version: string): Channel => (version.includes('-') ? 'beta' : 'stable')

/** A stable release goes in the beta feed too, so beta installs get the newest build of either kind. */
export const feedChannels = (version: string): Channel[] =>
  channelOf(version) === 'stable' ? ['stable', 'beta'] : ['beta']

export function withCargoVersion(toml: string, version: string): string {
  const lines = toml.split('\n')
  const start = lines.indexOf('[package]')
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    if (lines[i]!.startsWith('[')) break
    if (/^version\s*=/.test(lines[i]!)) {
      lines[i] = `version = "${version}"`
      return lines.join('\n')
    }
  }
  throw new Error('E_RELEASE_CARGO_VERSION_MISSING')
}

export function withPackageVersion(json: string, version: string): string {
  const data = JSON.parse(json) as Record<string, unknown>
  if (typeof data['version'] !== 'string') throw new Error('E_RELEASE_PACKAGE_VERSION_MISSING')
  data['version'] = version
  return `${JSON.stringify(data, null, 2)}\n`
}

export interface FeedInput {
  version: string
  notes: string
  date: Date
  url: string
  signature: string
}

/** Apple Silicon is the only platform Devot ships for. */
export function updateFeed(input: FeedInput) {
  if (!/^https:\/\//.test(input.url)) throw new Error('E_RELEASE_FEED_URL_INVALID')
  const signature = input.signature.trim()
  if (!signature) throw new Error('E_RELEASE_FEED_SIGNATURE_MISSING')
  return {
    version: input.version,
    notes: input.notes.trim(),
    pub_date: input.date.toISOString(),
    platforms: { 'darwin-aarch64': { signature, url: input.url } },
  }
}

function minisignLines(encoded: string, code: string): string[] {
  const lines = Buffer.from(encoded.trim(), 'base64').toString('utf8').split('\n')
  if (!lines[0]?.startsWith('untrusted comment:') || !lines[1]) throw new Error(code)
  return lines
}

/** `signature` and `publicKey` are Tauri's base64-wrapped minisign files; throws unless key ID and both signatures match. Returns the trusted comment. */
export function verifySignature(file: Uint8Array, signature: string, publicKey: string): string {
  const key = Buffer.from(minisignLines(publicKey, 'E_RELEASE_PUBKEY_MALFORMED')[1]!, 'base64')
  if (key.length !== 42 || key.toString('latin1', 0, 2) !== 'Ed')
    throw new Error('E_RELEASE_PUBKEY_MALFORMED')
  const lines = minisignLines(signature, 'E_RELEASE_SIGNATURE_MALFORMED')
  const sig = Buffer.from(lines[1]!, 'base64')
  const trusted = lines[2]?.match(/^trusted comment: (.*)$/)?.[1]
  const global = Buffer.from(lines[3] ?? '', 'base64')
  const algorithm = sig.toString('latin1', 0, 2)
  if (sig.length !== 74 || !['Ed', 'ED'].includes(algorithm) || trusted === undefined)
    throw new Error('E_RELEASE_SIGNATURE_MALFORMED')
  if (global.length !== 64) throw new Error('E_RELEASE_SIGNATURE_MALFORMED')
  if (!sig.subarray(2, 10).equals(key.subarray(2, 10)))
    throw new Error('E_RELEASE_SIGNATURE_KEY_MISMATCH')
  const ed25519 = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: key.subarray(10).toString('base64url') },
    format: 'jwk',
  })
  // "ED" signs the file's BLAKE2b-512 hash (what Tauri writes), "Ed" the file.
  const message = algorithm === 'ED' ? createHash('blake2b512').update(file).digest() : file
  const body = sig.subarray(10)
  if (!verify(null, message, ed25519, body)) throw new Error('E_RELEASE_SIGNATURE_INVALID')
  const comment = Buffer.concat([body, Buffer.from(trusted, 'utf8')])
  if (!verify(null, comment, ed25519, global)) throw new Error('E_RELEASE_SIGNATURE_INVALID')
  return trusted
}

/** The `version:` field the updater checks when `requireSignedVersion` is on. */
export const signedVersion = (trustedComment: string): string | undefined =>
  trustedComment
    .split('\t')
    .find((field) => field.startsWith('version:'))
    ?.slice('version:'.length)

export interface SigningKey {
  keynum: Buffer
  key: KeyObject
}

// minisign's limits on the key's scrypt parameters.
const SCRYPT_N_LOG2_MAX = 20
const SCRYPT_MEMLIMIT_MAX = 1_073_741_824
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')

/** libsodium's scrypt parameters for an opslimit and memlimit, as minisign derives them. */
export function scryptParams(opslimit: number, memlimit: number) {
  const ops = Math.max(32768, opslimit)
  const r = 8
  const maxN =
    ops < Math.floor(memlimit / 32) ? Math.floor(ops / (r * 4)) : Math.floor(memlimit / (r * 128))
  let log2 = 1
  while (log2 < 63 && 2 ** log2 <= Math.floor(maxN / 2)) log2++
  const p =
    ops < Math.floor(memlimit / 32)
      ? 1
      : Math.floor(Math.min(0x3fffffff, Math.floor(ops / 4 / 2 ** log2)) / r)
  if (log2 > SCRYPT_N_LOG2_MAX || memlimit > SCRYPT_MEMLIMIT_MAX)
    throw new Error('E_RELEASE_SECRET_KEY_MALFORMED')
  return { N: 2 ** log2, r, p }
}

/** Opens a secret key as `tauri signer generate` writes it: a base64-wrapped minisign key, scrypt-encrypted. */
export function signingKey(encoded: string, password: string): SigningKey {
  const raw = Buffer.from(minisignLines(encoded, 'E_RELEASE_SECRET_KEY_MALFORMED')[1]!, 'base64')
  if (raw.length !== 158 || raw.toString('latin1', 0, 2) !== 'Ed')
    throw new Error('E_RELEASE_SECRET_KEY_MALFORMED')
  const kdf = raw.toString('latin1', 2, 4)
  // keynum (8), Ed25519 seed (32), public key (32), checksum (32)
  const keynumSk = Buffer.from(raw.subarray(54))
  if (kdf === 'Sc') {
    const { N, r, p } = scryptParams(
      Number(raw.readBigUInt64LE(38)),
      Number(raw.readBigUInt64LE(46)),
    )
    const stream = scryptSync(password, raw.subarray(6, 38), keynumSk.length, {
      N,
      r,
      p,
      maxmem: 256 * N * r + 128 * r * p,
    })
    for (let i = 0; i < keynumSk.length; i++) keynumSk[i]! ^= stream[i]!
  } else if (kdf !== '\0\0') {
    throw new Error('E_RELEASE_SECRET_KEY_MALFORMED')
  }
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, keynumSk.subarray(8, 40)]),
    format: 'der',
    type: 'pkcs8',
  })
  // A wrong password decrypts to a seed whose public key is not the one stored beside it.
  const derived = Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x!, 'base64url')
  if (!derived.equals(keynumSk.subarray(40, 72))) throw new Error('E_RELEASE_SECRET_KEY_PASSWORD')
  return { keynum: keynumSk.subarray(0, 8), key }
}

/** A prehashed minisign signature, base64-wrapped, with the trusted comment `tauri build` writes. */
export function signFile(
  file: Uint8Array,
  name: string,
  version: string,
  signer: SigningKey,
  date: Date,
): string {
  if (/[\t\r\n]/.test(name + version)) throw new Error('E_RELEASE_SIGN_COMMENT_INVALID')
  const trusted = `timestamp:${Math.floor(date.getTime() / 1000)}\tfile:${name}\tversion:${version}`
  const body = sign(null, createHash('blake2b512').update(file).digest(), signer.key)
  const global = sign(null, Buffer.concat([body, Buffer.from(trusted, 'utf8')]), signer.key)
  const text = [
    'untrusted comment: signature from tauri secret key',
    Buffer.concat([Buffer.from('ED'), signer.keynum, body]).toString('base64'),
    `trusted comment: ${trusted}`,
    global.toString('base64'),
    '',
  ].join('\n')
  return Buffer.from(text).toString('base64')
}

function main(args: string[]) {
  const root = join(import.meta.dirname, '../..')
  const [command, tag, ...rest] = args
  if (command === 'set-version' && tag && rest.length === 0) {
    const version = versionFromTag(tag)
    const cargo = join(root, 'src-tauri/Cargo.toml')
    const pkg = join(root, 'package.json')
    writeFileSync(cargo, withCargoVersion(readFileSync(cargo, 'utf8'), version))
    writeFileSync(pkg, withPackageVersion(readFileSync(pkg, 'utf8'), version))
    console.log(`version=${version}\nchannel=${channelOf(version)}`)
    return
  }
  if (command === 'feeds' && tag && rest.length === 0) {
    console.log(feedChannels(versionFromTag(tag)).join('\n'))
    return
  }
  if (command === 'replaces-feed' && tag && (rest.length === 1 || rest.length === 2)) {
    let feed = ''
    try {
      feed = readFileSync(rest[0]!, 'utf8')
    } catch {
      // No feed yet.
    }
    const signature = rest[1] === undefined ? undefined : readFileSync(rest[1], 'utf8')
    console.log(`replace=${replacesFeed(versionFromTag(tag), feed, signature)}`)
    return
  }
  if (command === 'feed' && tag && rest.length === 4) {
    const [url, signatureFile, notesFile, out] = rest as [string, string, string, string]
    const feed = updateFeed({
      version: versionFromTag(tag),
      notes: readFileSync(notesFile, 'utf8'),
      date: new Date(),
      url,
      signature: readFileSync(signatureFile, 'utf8'),
    })
    writeFileSync(out, `${JSON.stringify(feed, null, 2)}\n`)
    return
  }
  if (command === 'sign' && tag && rest.length === 2) {
    const [file, out] = rest as [string, string]
    const encoded = process.env['TAURI_SIGNING_PRIVATE_KEY']
    if (!encoded) throw new Error('E_RELEASE_SECRET_KEY_MISSING')
    const signer = signingKey(encoded, process.env['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] ?? '')
    const version = versionFromTag(tag)
    writeFileSync(out, signFile(readFileSync(file), basename(file), version, signer, new Date()))
    return
  }
  if (command === 'verify-signature' && tag && (rest.length === 2 || rest.length === 3)) {
    const [signatureFile, publicKey, release] = rest as [string, string, string?]
    const trusted = verifySignature(
      readFileSync(tag),
      readFileSync(signatureFile, 'utf8'),
      publicKey,
    )
    if (release !== undefined && signedVersion(trusted) !== versionFromTag(release)) {
      throw new Error(`E_RELEASE_SIGNED_VERSION_MISMATCH: ${JSON.stringify(trusted)}`)
    }
    console.log('The signature matches the public key.')
    return
  }
  throw new Error(
    'E_RELEASE_USAGE: set-version <tag> | feeds <tag> | replaces-feed <tag> <feed> [<sig>] | feed <tag> <url> <sig> <notes> <out> | sign <tag> <file> <out> | verify-signature <file> <sig> <pubkey> [<tag>]',
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
}
