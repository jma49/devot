// Release-build Sentry upload settings, debug-symbol lookup, and checks that keep source maps
// and UI-test storage out of the app bundle.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export type Env = Record<string, string | undefined>

export const UPLOAD_SETTINGS = ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'] as const

export interface Upload {
  token: string
  org: string
  project: string
}

/** Some but not all settings is a mistake: it stops the build instead of skipping the upload. Debug builds never upload. */
export function uploadSettings(env: Env): Upload | undefined {
  if (env['TAURI_ENV_DEBUG'] === 'true') return undefined
  const [token = '', org = '', project = ''] = UPLOAD_SETTINGS.map((k) => env[k]?.trim() ?? '')
  const missing = UPLOAD_SETTINGS.filter((_, i) => ![token, org, project][i])
  if (missing.length === UPLOAD_SETTINGS.length) return undefined
  if (missing.length > 0) {
    throw new Error(
      `E_SENTRY_UPLOAD_SETTINGS_INCOMPLETE: also set ${missing.join(', ')}, or none of them`,
    )
  }
  return { token, org, project }
}

/** The settings travel in the environment, never as arguments. */
export function cliEnv(upload: Upload): Env {
  return {
    ...process.env,
    SENTRY_AUTH_TOKEN: upload.token,
    SENTRY_ORG: upload.org,
    SENTRY_PROJECT: upload.project,
  }
}

/** `version` in src-tauri/Cargo.toml's [package] table; tauri.conf.json names none. */
export function appVersion(root: string): string {
  const lines = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8').split('\n')
  const start = lines.indexOf('[package]')
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (line.startsWith('[')) break
    const version = /^version\s*=\s*"([^"]+)"/.exec(line)?.[1]
    if (version) return version
  }
  throw new Error('E_APP_VERSION_MISSING: src-tauri/Cargo.toml names no package version')
}

export function releaseName(root: string): string {
  return `devot@${appVersion(root)}`
}

/**
 * Newest of the binary and the dSYM's DWARF file (the dSYM folder keeps the time of the build
 * that first made it); -1 without a dSYM.
 */
function builtAt(release: string): number {
  const dsym = join(release, 'devot.dSYM')
  if (!existsSync(dsym)) return -1
  const dwarf = join(dsym, 'Contents/Resources/DWARF')
  const files = [
    join(release, 'devot'),
    ...(existsSync(dwarf) ? readdirSync(dwarf).map((name) => join(dwarf, name)) : []),
  ]
  return Math.max(0, ...files.filter((f) => existsSync(f)).map((f) => statSync(f).mtimeMs))
}

/**
 * Tauri names the target triple even without `--target`, so the newest of `target/<triple>/release`
 * and `target/release` is the build. A missing folder is still listed so the caller can name it.
 */
export function dsymPaths(root: string, env: Env): string[] {
  const target = env['CARGO_TARGET_DIR'] || join(root, 'src-tauri/target')
  const release = (triple: string) => join(target, triple, 'release')
  const dsym = (triple: string) => join(release(triple), 'devot.dSYM')
  const triple = env['TAURI_ENV_TARGET_TRIPLE']
  if (triple === 'universal-apple-darwin') {
    return [dsym('aarch64-apple-darwin'), dsym('x86_64-apple-darwin')]
  }
  if (!triple) return [dsym('')]
  return [builtAt(release(triple)) > builtAt(release('')) ? dsym(triple) : dsym('')]
}

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
}

const isMap = (file: string) => file.endsWith('.map')
const MAP_COMMENT = /^[ \t]*(?:\/\/|\/\*)[#@][ \t]*sourceMappingURL=/m
const TEXT = /\.(?:[cm]?js|css|html)$/

export function removeSourceMaps(dir: string): string[] {
  const maps = files(dir).filter(isMap)
  for (const map of maps) rmSync(join(dir, map))
  return maps
}

export function sourceMapLeaks(dir: string): string[] {
  return files(dir).filter(
    (file) =>
      isMap(file) || (TEXT.test(file) && MAP_COMMENT.test(readFileSync(join(dir, file), 'utf8'))),
  )
}

/**
 * Key prefix of the UI tests' in-memory storage (src/renderer/src/storage/memory.ts); a bundle
 * holding it would keep notes where backups and devot-mcp don't see them.
 */
export const TEST_STORAGE_MARKER = 'devot.test.'

export function testStorageLeaks(dir: string): string[] {
  return files(dir).filter(
    (file) =>
      TEXT.test(file) && readFileSync(join(dir, file), 'utf8').includes(TEST_STORAGE_MARKER),
  )
}

export function argument(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

/** sentry-cli from the dev dependencies; tests put a stand-in in its place. */
export function sentryCli(root: string): string {
  return process.env['DEVOT_SENTRY_CLI'] || join(root, 'node_modules/.bin/sentry-cli')
}
