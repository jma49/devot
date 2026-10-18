// The release workflow's steps (.github/workflows/release.yml, docs/releasing.md):
//
//   node scripts/release/release.ts set-version <tag>
//     Checks the tag (vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-beta.N) and
//     writes its version to package.json and src-tauri/Cargo.toml; Tauri
//     takes the app's version from Cargo. Prints the version and channel as
//     `version=…` and `channel=…` lines (for $GITHUB_OUTPUT).
//
//   node scripts/release/release.ts replaces-feed <tag> <current feed file>
//     Prints `replace=true` when the release is newer than the feed's (or the
//     file is empty or missing), `replace=false` otherwise.
//
//   node scripts/release/release.ts feed <tag> <url> <signature file> <notes file> <out file>
//     Writes the update feed for the release: what the app's updater reads
//     from the channel file in the `updater` release (beta.json until 1.0).
//
// Errors carry a code and end the run with status 1.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Channel = 'stable' | 'beta'

const TAG = /^v(\d+)\.(\d+)\.(\d+)(-beta\.(\d+))?$/

/** The version a release tag names, without its `v`; throws for any other tag. */
export function versionFromTag(tag: string): string {
  const match = TAG.exec(tag)
  // No leading zeros: semver refuses them, and the updater compares semver.
  const parts = match?.slice(1, 4).concat(match[5] ?? []) ?? []
  if (!match || parts.some((n) => n.length > 1 && n.startsWith('0'))) {
    throw new Error(`E_RELEASE_TAG_INVALID: ${JSON.stringify(tag)}`)
  }
  return tag.slice(1)
}

/** Orders two release versions (as `versionFromTag` gives them): negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const tag = TAG.exec(`v${v}`)
    if (!tag) throw new Error(`E_RELEASE_VERSION_INVALID: ${JSON.stringify(v)}`)
    // A release comes after every beta of the same version.
    return [tag[1], tag[2], tag[3], tag[5] ?? Infinity].map(Number)
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
  if (typeof current !== 'string' || !TAG.test(`v${current}`)) return true
  return compareVersions(version, current) > 0
}

/** The update channel of a version: beta for a prerelease. */
export const channelOf = (version: string): Channel => (version.includes('-') ? 'beta' : 'stable')

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
  throw new Error(
    'E_RELEASE_USAGE: set-version <tag> | replaces-feed <tag> <feed> | feed <tag> <url> <sig> <notes> <out>',
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
