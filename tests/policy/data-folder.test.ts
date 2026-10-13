import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Development and test runs never touch the notes of an installed Devot:
// debug builds keep their data in a folder of their own
// (src-tauri/src/data_folder.rs), and the scripts that start the app (the
// smoke check, the launch cost measurement) and everything CI and the git
// hooks run use that folder or a temporary one, never the release app's.

const root = join(import.meta.dirname, '../..')
const read = (file: string) => readFileSync(join(root, file), 'utf8')

/** The release app's identifier, which names its data folder. */
const release = (JSON.parse(read('src-tauri/tauri.conf.json')) as { identifier: string }).identifier

/** What debug builds add to it. */
function devSuffix(): string {
  const suffix = /const DEV_SUFFIX: &str = "([^"]+)";/.exec(read('src-tauri/src/data_folder.rs'))
  expect(suffix).not.toBeNull()
  return suffix![1]!
}

/** Tracked (and new, not ignored) files under the given paths. */
function files(...paths: string[]): string[] {
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard', ...paths], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
}

/** What scripts, CI and the git hooks run. */
const run = () => files('scripts', 'package.json', 'lefthook.yml', '.github')

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

it('debug builds keep their data next to the release folder, under their own name', () => {
  expect(release).toBe('io.github.jma49.devot')
  expect(devSuffix()).toBe('.dev')
})

it('the app is built only from the context that names its folders for the build', () => {
  const contexts = files('src-tauri/src').filter(
    (file) => file.endsWith('.rs') && read(file).includes('generate_context!'),
  )
  expect(contexts).toEqual(['src-tauri/src/data_folder.rs'])
})

it("no script names the release app's data folder", () => {
  // The release identifier, unless the debug builds' suffix follows it.
  const named = new RegExp(`${escape(release)}(?!${escape(devSuffix())}(?![\\w.-]))`)
  expect(run().filter((file) => named.test(read(file)))).toEqual([])
})

it("every app data path in a script is the debug builds' folder", () => {
  const folders = run().flatMap((file) =>
    [...read(file).matchAll(/Application Support\/([^/"'\s]*)/g)].map((m) => `${file}: ${m[1]}`),
  )
  // The scripts that start the app find it through scripts/app-data.sh.
  expect(folders).toContain(`scripts/app-data.sh: ${release}${devSuffix()}`)
  expect(folders.filter((f) => !f.endsWith(`: ${release}${devSuffix()}`))).toEqual([])
})

it('scripts end only the processes they started', () => {
  // pkill and killall match by name: they would also end an installed
  // Devot, without the handshake that saves its last edits.
  expect(files('scripts').filter((file) => /\b(pkill|killall)\b/.test(read(file)))).toEqual([])
})

it('the scripts start only an app whose data folder they know', () => {
  // The smoke check starts the debug bundle and stops unless it opened the
  // dev database. It starts it with a HOME of its own in which only the dev
  // folder is real (dev_app_home in scripts/app-data.sh): a bundle that keeps
  // its data elsewhere, such as one built before debug builds had a folder
  // of their own, opens a new database there and is stopped having touched
  // nothing real.
  const smoke = read('scripts/smoke/quit-saves.sh')
  expect(smoke).toContain('APP="$ROOT/src-tauri/target/debug/bundle/macos/Devot.app"')
  expect(smoke.match(/"\$APP\/Contents\/MacOS\/devot"/g)).toHaveLength(1)
  expect(smoke).toContain('HOME="$APP_HOME" "$APP/Contents/MacOS/devot"')
  expect(smoke.match(/\bAPP_HOME=[^\n]*/g)).toEqual(['APP_HOME="$WORK/home"'])
  expect(smoke).toContain('dev_app_home "$APP_HOME"')
  expect(smoke).toContain('app_wait_for_db "$PID" "$DEVOT_DEV_DATA"')
  // The launch cost script starts any build, release ones too, through the
  // probe, always with HOME in its own temporary folder.
  const perf = read('scripts/perf/launch-cost.sh')
  expect(perf.match(/"\$PROBE" "\$APP"/g)).toHaveLength(1)
  expect(perf).toContain('HOME="$APP_HOME" "$PROBE" "$APP"')
  expect(perf).toContain('app_wait_for_db "$PID" "$APP_HOME"')
})

it('the smoke check copies the dev notes aside before deleting any', () => {
  const smoke = read('scripts/smoke/quit-saves.sh')
  expect(smoke).toContain('scripts/app-data.sh')
  const begin = smoke.indexOf('dev_data_begin')
  expect(begin).toBeGreaterThan(-1)
  expect(begin).toBeLessThan(smoke.indexOf('dev_data_clear'))
  // It deletes databases only through the helpers, which know the folder.
  expect(smoke).not.toMatch(/\brm\b[^\n]*sqlite/)
})
