// Uploads the app's debug symbols (devot.dSYM, made by release builds next to
// the binary) to Sentry, so that native crash reports show function names.
// Tauri runs it after compiling the app and before bundling it
// (`beforeBundleCommand`); the dSYM is never part of the bundle. Uploads run
// only for release builds with the Sentry upload settings (upload.ts).
//
// Options: --env-dir <dir> (where .env files are read, default the
// repository root).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnv } from 'vite'
import { argument, cliEnv, dsymPaths, sentryCli, uploadSettings, type Upload } from './upload.ts'

const root = join(import.meta.dirname, '../..')
const env = { ...process.env, ...loadEnv('production', argument('--env-dir') ?? root, 'SENTRY_') }

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

let settings: Upload | undefined
try {
  settings = uploadSettings(env)
} catch (error) {
  fail((error as Error).message)
}
if (!settings) {
  console.log('I_DSYM_UPLOAD_SKIPPED: not a release build with the Sentry upload settings')
  process.exit(0)
}

const paths = dsymPaths(root, env)
const missing = paths.filter((path) => !existsSync(path))
if (missing.length > 0) fail(`E_DSYM_MISSING: ${missing.join(' ')}`)
for (const path of paths) {
  const run = spawnSync(sentryCli(root), ['debug-files', 'upload', path], {
    stdio: 'inherit',
    env: cliEnv(settings),
  })
  if (run.status !== 0) fail('E_DSYM_UPLOAD_FAILED: sentry-cli failed')
}
console.log(`I_DSYM_UPLOADED: ${paths.length}`)
