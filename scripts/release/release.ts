// The release workflow's steps (.github/workflows/release.yml, docs/releasing.md):
//
//   node scripts/release/release.ts set-version <tag>
//     Checks the tag (vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-betaN) and
//     writes its version to package.json and src-tauri/Cargo.toml; Tauri
//     takes the app's version from Cargo. Prints the version and channel as
//     `version=…` and `channel=…` lines (for $GITHUB_OUTPUT).
//
//   node scripts/release/release.ts replaces-feed <tag> <current feed file>
//     Prints `replace=true` when the release is newer than the feed's (or the
//     file is empty or missing), `replace=false` otherwise.
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
//   node scripts/release/release.ts verify-signature <file> <signature file> <public key>
//     Checks that the signature (the .sig Tauri wrote) is the file's, made
//     with the secret key of the public key the app is built with (the
//     TAURI_UPDATER_PUBKEY variable), so a release never ships an update no
//     install would take.
//
// Errors carry a code and end the run with status 1.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Channel = 'stable' | 'beta'

// N is one digit: as a semver prerelease identifier `beta10` would sort
// before `beta2`.
const TAG = /^v(\d+)\.(\d+)\.(\d+)(-beta([1-9]))?$/
// A version a feed may offer: a release tag's, or one from before tags
// dropped the dot (`0.9.0-beta.1`).
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-beta(?:([1-9])|\.(\d+)))?$/

/** The version a release tag names, without its `v`; throws for any other tag. */
export function versionFromTag(tag: string): string {
  const match = TAG.exec(tag)
  // No leading zeros: semver refuses them, and the updater compares semver.
  const parts = match?.slice(1, 4) ?? []
  if (!match || parts.some((n) => n.length > 1 && n.startsWith('0'))) {
    throw new Error(`E_RELEASE_TAG_INVALID: ${JSON.stringify(tag)}`)
  }
  return tag.slice(1)
}

/**
 * Orders two release versions (as `versionFromTag` gives them, or an older
 * `-beta.N` one from a feed): negative when `a` is older.
 */
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
 * Whether a release of `version` should replace the channel's feed (its
 * text, empty when there is none yet): only a newer version does, so a
 * release that finishes after a newer one never takes the feed back.
 */
export function replacesFeed(version: string, feed: string): boolean {
  let current: unknown
  try {
    current = (JSON.parse(feed) as { version?: unknown }).version
  } catch {
    return true
  }
  if (typeof current !== 'string' || !VERSION.test(current)) return true
  return compareVersions(version, current) > 0
}

/** The update channel of a version: beta for a prerelease. */
export const channelOf = (version: string): Channel => (version.includes('-') ? 'beta' : 'stable')

/**
 * The channel feeds a release of `version` goes in: its own channel's, and
 * for a stable release the beta feed too, so the beta channel offers the
 * newest build of either kind. Each feed still moves only when the release
 * is newer than what it offers (`replacesFeed`).
 */
export const feedChannels = (version: string): Channel[] =>
  channelOf(version) === 'stable' ? ['stable', 'beta'] : ['beta']

/** Cargo.toml with `version` in its [package] table; throws when it has none. */
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

/** package.json with `version`, keeping its layout (two spaces, final newline). */
export function withPackageVersion(json: string, version: string): string {
  const data = JSON.parse(json) as Record<string, unknown>
  if (typeof data['version'] !== 'string') throw new Error('E_RELEASE_PACKAGE_VERSION_MISSING')
  data['version'] = version
  return `${JSON.stringify(data, null, 2)}\n`
}

export interface FeedInput {
  version: string
  notes: string
  /** When the release was published. */
  date: Date
  /** The updater bundle (Devot.app.tar.gz) of the release. */
  url: string
  /** The bundle's signature (the .sig file's text). */
  signature: string
}

/**
 * The update feed for Apple Silicon (the only platform Devot ships for), in
 * the format Tauri's updater reads.
 */
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

/** The lines of a minisign file, which Tauri writes base64-encoded whole. */
function minisignLines(encoded: string, code: string): string[] {
  const lines = Buffer.from(encoded.trim(), 'base64').toString('utf8').split('\n')
  if (!lines[0]?.startsWith('untrusted comment:') || !lines[1]) throw new Error(code)
  return lines
}

/**
 * Checks a minisign signature, as Tauri's updater does: `signature` is the
 * .sig file's text and `publicKey` the key the app is built with, both as
 * Tauri writes them (base64 of the minisign file). Throws unless the key's
 * ID matches and both the file's and the trusted comment's signatures hold.
 */
export function verifySignature(file: Uint8Array, signature: string, publicKey: string): void {
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
  if (command === 'replaces-feed' && tag && rest.length === 1) {
    let feed = ''
    try {
      feed = readFileSync(rest[0]!, 'utf8')
    } catch {
      // No feed yet.
    }
    console.log(`replace=${replacesFeed(versionFromTag(tag), feed)}`)
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
  if (command === 'verify-signature' && tag && rest.length === 2) {
    const [signatureFile, publicKey] = rest as [string, string]
    verifySignature(readFileSync(tag), readFileSync(signatureFile, 'utf8'), publicKey)
    console.log('The signature matches the public key.')
    return
  }
  throw new Error(
    'E_RELEASE_USAGE: set-version <tag> | feeds <tag> | replaces-feed <tag> <feed> | feed <tag> <url> <sig> <notes> <out> | verify-signature <file> <sig> <pubkey>',
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
