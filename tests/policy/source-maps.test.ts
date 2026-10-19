import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  dsymPaths,
  releaseName,
  removeSourceMaps,
  sourceMapLeaks,
  TEST_STORAGE_MARKER,
  testStorageLeaks,
  uploadSettings,
} from '../../scripts/sentry/upload'
import { tempDir } from '../support/temp-dirs'

// Release builds upload source maps and debug symbols to Sentry when configured; the app bundle never
// carries a source map nor the UI tests' in-memory storage. Scripts run against a fake sentry-cli.

const root = join(import.meta.dirname, '../..')
// Configs written outside the repo have no node_modules to resolve a bare 'vite' from.
const vite = JSON.stringify(createRequire(import.meta.url).resolve('vite'))
const work = tempDir('devot-release-')
afterAll(() => rmSync(work, { recursive: true, force: true }))

const SETTINGS = {
  SENTRY_AUTH_TOKEN: 'sntrys_test_token_never_valid',
  SENTRY_ORG: 'test-org',
  SENTRY_PROJECT: 'test-project',
}

function tree(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
}

describe('upload settings', () => {
  it('turn uploads on only when the token, organisation and project are all set', () => {
    expect(uploadSettings({})).toBeUndefined()
    expect(uploadSettings({ SENTRY_AUTH_TOKEN: ' ', SENTRY_ORG: '' })).toBeUndefined()
    expect(uploadSettings(SETTINGS)).toEqual({
      token: SETTINGS.SENTRY_AUTH_TOKEN,
      org: 'test-org',
      project: 'test-project',
    })
  })

  it('stop the build when only some are set', () => {
    expect(() => uploadSettings({ SENTRY_AUTH_TOKEN: 'x', SENTRY_ORG: 'o' })).toThrow(
      /E_SENTRY_UPLOAD_SETTINGS_INCOMPLETE.*SENTRY_PROJECT/,
    )
  })

  it('never upload for a debug build', () => {
    expect(uploadSettings({ ...SETTINGS, TAURI_ENV_DEBUG: 'true' })).toBeUndefined()
    expect(uploadSettings({ ...SETTINGS, TAURI_ENV_DEBUG: 'false' })).toBeDefined()
  })

  it('name the release as the app does', () => {
    // Cargo.toml's version, as Rust reports it (tests/policy/release.test.ts).
    const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8')
    const version = /\[package\][^[]*?\nversion = "([^"]+)"/.exec(cargo)?.[1]
    expect(releaseName(root)).toBe(`devot@${version}`)
  })
})

describe('source map checks', () => {
  it('find map files and comments that point to a map', () => {
    const dir = join(work, 'leaks')
    tree(dir, {
      'index.html': '<script src="a.js"></script>',
      'assets/a.js': 'console.log(1)\n//# sourceMappingURL=a.js.map\n',
      'assets/a.js.map': '{}',
      'assets/b.css': 'p{}\n/*# sourceMappingURL=b.css.map */\n',
      'assets/old.js': 'f()\n//@ sourceMappingURL=old.js.map',
      // Text that only mentions the comment is not one.
      'assets/clean.js': 'const s = "//# sourceMappingURL=x"; //# debugId=1\n',
      'assets/w/c.mjs.map': '{}',
    })
    expect(sourceMapLeaks(dir).sort()).toEqual([
      'assets/a.js',
      'assets/a.js.map',
      'assets/b.css',
      'assets/old.js',
      'assets/w/c.mjs.map',
    ])
    expect(removeSourceMaps(dir).sort()).toEqual(['assets/a.js.map', 'assets/w/c.mjs.map'])
    expect(sourceMapLeaks(dir).sort()).toEqual(['assets/a.js', 'assets/b.css', 'assets/old.js'])
  })

  it('find the dSYM of the build Tauri made', () => {
    const target = join(root, 'src-tauri/target')
    expect(dsymPaths(root, {})).toEqual([join(target, 'release/devot.dSYM')])
    expect(dsymPaths(root, { TAURI_ENV_TARGET_TRIPLE: 'universal-apple-darwin' })).toEqual([
      join(target, 'aarch64-apple-darwin/release/devot.dSYM'),
      join(target, 'x86_64-apple-darwin/release/devot.dSYM'),
    ])
  })

  // Tauri names the triple with or without --target, so both folders may hold a build: the last wins.
  // Rebuilding rewrites the binary and DWARF file inside a dSYM but keeps the dSYM folder's own time.
  describe('with and without --target', () => {
    const dir = join(work, 'target-triples')
    const env = { CARGO_TARGET_DIR: dir, TAURI_ENV_TARGET_TRIPLE: 'aarch64-apple-darwin' }
    const plain = join(dir, 'release/devot.dSYM')
    const triple = join(dir, 'aarch64-apple-darwin/release/devot.dSYM')
    const DWARF = 'Contents/Resources/DWARF'
    function build(release: string, time: number) {
      const at = new Date(time)
      tree(join(dir, release), {
        devot: 'binary',
        [`devot.dSYM/${DWARF}/devot-0123abcd`]: 'dwarf',
      })
      for (const path of ['devot', `devot.dSYM/${DWARF}/devot-0123abcd`]) {
        utimesSync(join(dir, release, path), at, at)
      }
    }
    function folderTime(dsym: string, time: number) {
      const at = new Date(time)
      for (const path of [dsym, join(dsym, 'Contents'), join(dsym, 'Contents/Resources')]) {
        utimesSync(path, at, at)
      }
      utimesSync(join(dsym, DWARF), at, at)
    }

    it('falls back to target/release when neither build exists', () => {
      expect(dsymPaths(root, env)).toEqual([plain])
    })

    it('takes the only build there is', () => {
      build('aarch64-apple-darwin/release', 2_000_000)
      expect(dsymPaths(root, env)).toEqual([triple])
    })

    it('takes the build made last, whatever the dSYM folders say', () => {
      build('release', 1_000_000)
      build('aarch64-apple-darwin/release', 2_000_000)
      folderTime(plain, 1_000_000)
      folderTime(triple, 2_000_000)
      expect(dsymPaths(root, env)).toEqual([triple])
      build('release', 3_000_000)
      folderTime(plain, 1_000_000)
      expect(dsymPaths(root, env)).toEqual([plain])
    })

    it('goes by the DWARF file when the binary is gone', () => {
      build('release', 4_000_000)
      build('aarch64-apple-darwin/release', 5_000_000)
      rmSync(join(dir, 'release/devot'))
      rmSync(join(dir, 'aarch64-apple-darwin/release/devot'))
      folderTime(plain, 9_000_000)
      folderTime(triple, 1_000_000)
      expect(dsymPaths(root, env)).toEqual([triple])
    })
  })
})

/** A sentry-cli stand-in: logs each call and the source maps present then. */
function fakeCli(name: string, failOn?: string): { cli: string; log: string } {
  const cli = join(work, `${name}-sentry-cli.mjs`)
  const log = join(work, `${name}-calls.jsonl`)
  writeFileSync(
    cli,
    `#!/usr/bin/env node
import { appendFileSync, readdirSync } from 'node:fs'
const args = process.argv.slice(2)
const dir = args.at(-1)
let maps = 0
try {
  maps = readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.map')).length
} catch {}
const env = ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'].map((k) => process.env[k] ?? '')
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env, maps }) + '\\n')
process.exit(args.join(' ').startsWith(${JSON.stringify(failOn ?? '-')}) ? 1 : 0)
`,
  )
  chmodSync(cli, 0o755)
  return { cli, log }
}

interface Call {
  args: string[]
  env: string[]
  maps: number
}

function calls(log: string): Call[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Call)
}

function runScript(script: string, cli: string, env: Record<string, string>, args: string[] = []) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith('SENTRY_') && !k.startsWith('TAURI_'),
    ),
  )
  // An empty folder for .env files, so a developer's own settings never apply.
  const envDir = mkdtempSync(join(work, 'env-'))
  return spawnSync('node', [join(root, 'scripts/sentry', script), '--env-dir', envDir, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...clean,
      DEVOT_SENTRY_DSN: '',
      DEVOT_SENTRY_CLI: cli,
      // Were the fake ever bypassed, sentry-cli would find nothing here.
      SENTRY_URL: 'http://127.0.0.1:9',
      ...env,
    },
  })
}

describe('release UI build', () => {
  const BUILD = 180_000

  it(
    'with the settings, uploads hidden source maps, then removes every one',
    () => {
      const out = join(work, 'dist-upload')
      const { cli, log } = fakeCli('upload')
      const run = runScript('ui.ts', cli, SETTINGS, ['--out-dir', out])
      expect({ status: run.status, stderr: run.stderr }).toMatchObject({ status: 0 })

      const made = calls(log)
      expect(made.map((c) => c.args)).toEqual([
        ['sourcemaps', 'inject', out],
        ['sourcemaps', 'upload', '--release', releaseName(root), out],
      ])
      // The maps existed while sentry-cli ran; the token went by environment.
      expect(made[1]!.maps).toBeGreaterThan(10)
      for (const call of made) {
        expect(call.env).toEqual(Object.values(SETTINGS))
        expect(call.args.join(' ')).not.toContain(SETTINGS.SENTRY_AUTH_TOKEN)
      }

      expect(sourceMapLeaks(out)).toEqual([])
      const files = allFiles(out)
      expect(files.some((f) => f.endsWith('.js'))).toBe(true)
      for (const file of files) {
        expect(readFileSync(file, 'utf8')).not.toContain(SETTINGS.SENTRY_AUTH_TOKEN)
      }
    },
    BUILD,
  )

  it(
    'without the settings, builds no source maps and never calls sentry-cli',
    () => {
      const out = join(work, 'dist-plain')
      const { cli, log } = fakeCli('plain')
      const run = runScript('ui.ts', cli, {}, ['--out-dir', out])
      expect({ status: run.status, stderr: run.stderr }).toMatchObject({ status: 0 })
      expect(run.stdout).toContain('I_SOURCEMAP_UPLOAD_SKIPPED')
      expect(calls(log)).toEqual([])
      expect(allFiles(out).length).toBeGreaterThan(3)
      expect(sourceMapLeaks(out)).toEqual([])
    },
    BUILD,
  )

  it(
    'removes the maps and fails the build when the upload fails',
    () => {
      const out = join(work, 'dist-failed')
      const { cli, log } = fakeCli('failed', 'sourcemaps upload')
      const run = runScript('ui.ts', cli, SETTINGS, ['--out-dir', out])
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('E_SOURCEMAP_UPLOAD_FAILED')
      expect(calls(log)).toHaveLength(2)
      expect(sourceMapLeaks(out)).toEqual([])
    },
    BUILD,
  )

  it(
    'removes the maps when the build itself fails after writing them',
    () => {
      const out = join(work, 'dist-broken')
      // The app's config plus a plugin that fails once every file is written and maps remain.
      const config = join(work, 'broken.vite.config.ts')
      const counted = join(work, 'broken-maps.txt')
      writeFileSync(
        config,
        `import { readdirSync, writeFileSync } from 'node:fs'
import { mergeConfig } from ${vite}
import base from ${JSON.stringify(join(root, 'vite.config.ts'))}
export default mergeConfig(base, {
  plugins: [{
    name: 'fail-after-writing',
    closeBundle() {
      const maps = readdirSync(${JSON.stringify(out)}, { recursive: true })
        .filter((f) => String(f).endsWith('.map')).length
      writeFileSync(${JSON.stringify(counted)}, String(maps))
      throw new Error('E_TEST_BUILD_FAILED')
    },
  }],
})
`,
      )
      const { cli, log } = fakeCli('broken')
      const run = runScript('ui.ts', cli, SETTINGS, ['--out-dir', out, '--config', config])
      expect(run.status).not.toBe(0)
      expect(run.stderr + run.stdout).toContain('E_TEST_BUILD_FAILED')
      expect(calls(log)).toEqual([])
      expect(Number(readFileSync(counted, 'utf8'))).toBeGreaterThan(10)
      expect(allFiles(out).some((f) => f.endsWith('.js'))).toBe(true)
      expect(sourceMapLeaks(out)).toEqual([])
    },
    BUILD,
  )

  // The UI tests' in-memory storage (storage/memory.ts) is chosen at build time by their Vite config;
  // the app must never use it, or notes would sit in local storage where backups and devot-mcp can't see them.
  it(
    "leaves the UI tests' storage out, whatever VITE_DEVOT_STORAGE says",
    () => {
      const out = join(work, 'dist-storage')
      // The old switch, in .env.local and in the environment, does nothing.
      const envDir = mkdtempSync(join(work, 'storage-env-'))
      writeFileSync(join(envDir, '.env.local'), 'VITE_DEVOT_STORAGE=memory\n')
      const config = join(work, 'storage.vite.config.ts')
      writeFileSync(
        config,
        `import { mergeConfig } from ${vite}
import base from ${JSON.stringify(join(root, 'vite.config.ts'))}
export default mergeConfig(base, { envDir: ${JSON.stringify(envDir)} })
`,
      )
      const { cli } = fakeCli('storage')
      const env = { VITE_DEVOT_STORAGE: 'memory' }
      const run = runScript('ui.ts', cli, env, ['--out-dir', out, '--config', config])
      expect({ status: run.status, stderr: run.stderr }).toMatchObject({ status: 0 })
      expect(allFiles(out).some((f) => f.endsWith('.js'))).toBe(true)
      expect(testStorageLeaks(out)).toEqual([])
    },
    BUILD,
  )

  it(
    "fails, and uploads nothing, when the bundle holds the UI tests' storage",
    () => {
      const out = join(work, 'dist-ui-test')
      const { cli, log } = fakeCli('ui-test')
      const config = join(root, 'vite.ui-test.config.ts')
      const run = runScript('ui.ts', cli, SETTINGS, ['--out-dir', out, '--config', config])
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('E_TEST_STORAGE_IN_RELEASE')
      expect(testStorageLeaks(out).length).toBeGreaterThan(0)
      expect(calls(log)).toEqual([])
      expect(sourceMapLeaks(out)).toEqual([])
    },
    BUILD,
  )

  it('stops before building when only some settings are set', () => {
    const out = join(work, 'dist-partial')
    const { cli, log } = fakeCli('partial')
    const run = runScript('ui.ts', cli, { SENTRY_AUTH_TOKEN: 'x' }, ['--out-dir', out])
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('E_SENTRY_UPLOAD_SETTINGS_INCOMPLETE')
    expect(existsSync(out)).toBe(false)
    expect(calls(log)).toEqual([])
  })
})

describe("the UI tests' storage check", () => {
  it('finds the in-memory storage in any built file', () => {
    const dir = join(work, 'storage-leaks')
    tree(dir, {
      'index.html': '<script src="assets/a.js"></script>',
      'assets/a.js': `localStorage.getItem("${TEST_STORAGE_MARKER}notes")`,
      'assets/w/b.js': 'localStorage.getItem("devot.node")',
    })
    expect(testStorageLeaks(dir)).toEqual(['assets/a.js'])
  })

  it('looks for the keys the in-memory storage keeps notes under', () => {
    const memory = readFileSync(join(root, 'src/renderer/src/storage/memory.ts'), 'utf8')
    expect(memory).toContain(`'${TEST_STORAGE_MARKER}notes'`)
  })

  it("is on only in the UI tests' Vite config", async () => {
    const app = (await import('../../vite.config.ts')).default
    const uiTests = (await import('../../vite.ui-test.config.ts')).default
    expect(app.define).toMatchObject({ DEVOT_UI_TEST: 'false' })
    expect(uiTests.define).toMatchObject({ DEVOT_UI_TEST: 'true' })
  })
})

describe('debug symbol upload', () => {
  function target(name: string) {
    const dir = join(work, name)
    tree(dir, { 'release/devot.dSYM/Contents/Info.plist': '<plist/>' })
    return dir
  }

  it('uploads the release dSYM with the settings', () => {
    const dir = target('target-upload')
    const { cli, log } = fakeCli('dsym')
    const run = runScript('debug-files.ts', cli, { ...SETTINGS, CARGO_TARGET_DIR: dir })
    expect({ status: run.status, stderr: run.stderr }).toMatchObject({ status: 0 })
    expect(calls(log).map((c) => c.args)).toEqual([
      ['debug-files', 'upload', join(dir, 'release/devot.dSYM')],
    ])
    expect(calls(log)[0]!.env).toEqual(Object.values(SETTINGS))
  })

  it('skips without the settings and for debug builds', () => {
    const dir = target('target-skip')
    const { cli, log } = fakeCli('dsym-skip')
    expect(runScript('debug-files.ts', cli, { CARGO_TARGET_DIR: dir }).status).toBe(0)
    const debug = { ...SETTINGS, CARGO_TARGET_DIR: dir, TAURI_ENV_DEBUG: 'true' }
    expect(runScript('debug-files.ts', cli, debug).status).toBe(0)
    expect(calls(log)).toEqual([])
  })

  it('fails when the settings are set but the dSYM is missing', () => {
    const { cli, log } = fakeCli('dsym-missing')
    const run = runScript('debug-files.ts', cli, {
      ...SETTINGS,
      CARGO_TARGET_DIR: join(work, 'no-target'),
    })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('E_DSYM_MISSING')
    expect(calls(log)).toEqual([])
  })
})
