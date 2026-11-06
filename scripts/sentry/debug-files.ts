// Uploads devot.dSYM (made by release builds) to Sentry for native crash symbolication. Tauri runs it before bundling
// (`beforeBundleCommand`); only for release builds with the upload settings (upload.ts). With DEVOT_SENTRY_STAGE it
// copies the dSYM there for scripts/sentry/staged.ts instead.
// Options: --env-dir <dir> (where .env files are read, default the repository root).
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnv } from 'vite'
import {
  argument,
  cliEnv,
  dsymPaths,
  sentryCli,
  STAGE_AND_UPLOAD,
  stageDir,
  uploadSettings,
  type Upload,
} from './upload.ts'

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
const stage = stageDir(env)
if (stage && settings) fail(STAGE_AND_UPLOAD)
if (!settings && !stage) {
  console.log('I_DSYM_UPLOAD_SKIPPED: not a release build with the Sentry upload settings')
  process.exit(0)
}

const paths = dsymPaths(root, env)
const missing = paths.filter((path) => !existsSync(path))
if (missing.length > 0) fail(`E_DSYM_MISSING: ${missing.join(' ')}`)
if (!settings) {
  paths.forEach((path, i) =>
    cpSync(path, join(stage ?? '', 'dsym', String(i), 'devot.dSYM'), { recursive: true }),
  )
  console.log(`I_DSYM_STAGED: ${paths.length} in ${stage}`)
  process.exit(0)
}
const upload = settings
for (const path of paths) {
  const run = spawnSync(sentryCli(root), ['debug-files', 'upload', path], {
    stdio: 'inherit',
    env: cliEnv(upload),
  })
  if (run.status !== 0) fail('E_DSYM_UPLOAD_FAILED: sentry-cli failed')
}
console.log(`I_DSYM_UPLOADED: ${paths.length}`)
