// Uploads what a release build left in its staging folder (DEVOT_SENTRY_STAGE, upload.ts): the UI's
// source maps under the build's release name and the app's dSYMs. The release workflow runs it in a
// job of its own, so the job that runs the dependencies' code never holds the token. Without the
// upload settings it uploads nothing. Node modules only: the job installs nothing but sentry-cli.
//
// Options: --stage <dir> (the staging folder, as the build's artifact holds it).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { argument, cliEnv, sentryCli, uploadSettings, type Upload } from './upload.ts'

const root = join(import.meta.dirname, '../..')

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

let settings: Upload | undefined
try {
  settings = uploadSettings(process.env)
} catch (error) {
  fail((error as Error).message)
}
if (!settings) {
  console.log(
    'I_SENTRY_UPLOAD_SKIPPED: SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT are not set',
  )
  process.exit(0)
}
const upload = settings

const stage = resolve(argument('--stage') ?? fail('E_SENTRY_STAGE_MISSING: pass --stage <dir>'))
const ui = join(stage, 'ui')
const dsym = join(stage, 'dsym')
const releaseFile = join(stage, 'release')
if (!existsSync(ui) || !existsSync(releaseFile)) {
  fail(`E_SENTRY_STAGE_MISSING: ${stage} holds no staged UI build`)
}

const sentry = (args: string[]) =>
  spawnSync(sentryCli(root), args, { stdio: 'inherit', env: cliEnv(upload) }).status === 0

const release = readFileSync(releaseFile, 'utf8').trim()
if (!sentry(['sourcemaps', 'upload', '--release', release, ui])) {
  fail('E_SOURCEMAP_UPLOAD_FAILED: sentry-cli failed')
}
if (existsSync(dsym) && !sentry(['debug-files', 'upload', dsym])) {
  fail('E_DSYM_UPLOAD_FAILED: sentry-cli failed')
}
console.log(`I_SENTRY_UPLOADED: ${release}`)
