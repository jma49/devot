// Builds the UI for a release; Tauri runs it as `beforeBuildCommand`, which embeds dist/.
// With the Sentry upload settings (upload.ts) it builds hidden source maps, gives every script
// a debug ID, uploads the maps and deletes them; with DEVOT_SENTRY_STAGE it does the same but
// copies the maps there for scripts/sentry/staged.ts instead of uploading; with neither, it
// builds none. The build fails if
// dist/ holds a source map or a comment pointing to one, or (before uploading) the UI tests'
// in-memory storage (vite.ui-test.config.ts), so the app never keeps notes where backups and
// an outside writer cannot see them, or, unless Tauri builds a debug app, the spike probes.
//
// Options: --out-dir <dir> (default dist/), --env-dir <dir> (where .env files
// are read, default the repository root), --config <file> (the Vite config,
// default vite.config.ts).
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build, loadEnv } from 'vite'
import {
  argument,
  cliEnv,
  offlineEnv,
  releaseName,
  removeSourceMaps,
  sentryCli,
  sourceMapLeaks,
  spikeLeaks,
  STAGE_AND_UPLOAD,
  stageDir,
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

function stageMaps(stage: string) {
  const run = spawnSync(sentryCli(root), ['sourcemaps', 'inject', outDir], {
    stdio: 'inherit',
    env: offlineEnv(),
  })
  if (run.status !== 0) return false
  mkdirSync(stage, { recursive: true })
  cpSync(outDir, join(stage, 'ui'), { recursive: true })
  writeFileSync(join(stage, 'release'), releaseName(root))
  return true
}

let settings: Upload | undefined
try {
  settings = uploadSettings(env)
} catch (error) {
  fail((error as Error).message)
}
const stage = stageDir(env)
if (stage && settings) fail(STAGE_AND_UPLOAD)

let uploaded = true
let testStorage: string[] = []
let spikes: string[] = []
try {
  await build({
    configFile,
    build: { outDir, emptyOutDir: true, sourcemap: settings || stage ? 'hidden' : false },
  })
  // A bundle with the UI tests' storage never ships, so it uploads nothing.
  testStorage = testStorageLeaks(outDir)
  // Only a debug app's page carries the spike probes (DEVOT_SPIKES in vite.config.ts).
  if (env['TAURI_ENV_DEBUG'] !== 'true') spikes = spikeLeaks(outDir)
  if (testStorage.length === 0 && spikes.length === 0) {
    if (settings) uploaded = upload(settings)
    else if (stage) uploaded = stageMaps(stage)
    else
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
if (spikes.length > 0) fail(`E_SPIKES_IN_RELEASE: the spike probes are in ${spikes.join(' ')}`)
if (!uploaded) fail('E_SOURCEMAP_UPLOAD_FAILED: sentry-cli failed; the maps are deleted')
if (stage) console.log(`I_SOURCEMAPS_STAGED: in ${stage}, and deleted from the build`)
const leaks = sourceMapLeaks(outDir)
if (leaks.length > 0) fail(`E_SOURCEMAP_LEAK: ${leaks.join(' ')}`)
if (settings) console.log('I_SOURCEMAPS_UPLOADED: the maps are sent and deleted')
