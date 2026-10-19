// Builds the UI for a release; Tauri runs it as `beforeBuildCommand`, which embeds dist/.
// With the Sentry upload settings (upload.ts) it builds hidden source maps, gives every script
// a debug ID, uploads the maps and deletes them; without, it builds none. The build fails if
// dist/ holds a source map or a comment pointing to one, or (before uploading) the UI tests'
// in-memory storage (vite.ui-test.config.ts), so the app never keeps notes where backups and
// devot-mcp cannot see them.
//
// Options: --out-dir <dir> (default dist/), --env-dir <dir> (where .env files
// are read, default the repository root), --config <file> (the Vite config,
// default vite.config.ts).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build, loadEnv } from 'vite'
import {
  argument,
  cliEnv,
  releaseName,
  removeSourceMaps,
  sentryCli,
  sourceMapLeaks,
  testStorageLeaks,
  uploadSettings,
  type Upload,
} from './upload.ts'

const root = join(import.meta.dirname, '../..')
const outDir = resolve(argument('--out-dir') ?? join(root, 'dist'))
const configFile = resolve(argument('--config') ?? join(root, 'vite.config.ts'))
const env = { ...process.env, ...loadEnv('production', argument('--env-dir') ?? root, 'SENTRY_') }
// vite.config.ts names its root relative to the working directory.
process.chdir(root)

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function upload(settings: Upload) {
  const cli = sentryCli(root)
  for (const args of [
    ['sourcemaps', 'inject', outDir],
    ['sourcemaps', 'upload', '--release', releaseName(root), outDir],
  ]) {
    const run = spawnSync(cli, args, { stdio: 'inherit', env: cliEnv(settings) })
    if (run.status !== 0) return false
  }
  return true
}

let settings: Upload | undefined
try {
  settings = uploadSettings(env)
} catch (error) {
  fail((error as Error).message)
}

let uploaded = true
let testStorage: string[] = []
try {
  await build({
    configFile,
    build: { outDir, emptyOutDir: true, sourcemap: settings ? 'hidden' : false },
  })
  // A bundle with the UI tests' storage never ships, so it uploads nothing.
  testStorage = testStorageLeaks(outDir)
  if (settings && testStorage.length === 0) {
    uploaded = upload(settings)
  } else if (!settings) {
    console.log(
      'I_SOURCEMAP_UPLOAD_SKIPPED: SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT are not set',
    )
  }
} finally {
  // Even when the build or the upload fails, no map stays in dist/.
  if (existsSync(outDir)) removeSourceMaps(outDir)
}
if (testStorage.length > 0) {
  fail(`E_TEST_STORAGE_IN_RELEASE: the UI tests' storage is in ${testStorage.join(' ')}`)
}
if (!uploaded) fail('E_SOURCEMAP_UPLOAD_FAILED: sentry-cli failed; the maps are deleted')
const leaks = sourceMapLeaks(outDir)
if (leaks.length > 0) fail(`E_SOURCEMAP_LEAK: ${leaks.join(' ')}`)
if (settings) console.log('I_SOURCEMAPS_UPLOADED: the maps are sent and deleted')
