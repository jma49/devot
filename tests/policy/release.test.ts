import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { appVersion, releaseName } from '../../scripts/sentry/upload'

// One build reports one release and one environment, from Rust, from the UI
// and for the source maps it uploads.
const read = (path: string) => readFileSync(path, 'utf8')

/** `version` in Cargo.toml's [package] table. */
function cargoVersion(): string | undefined {
  const lines = read('src-tauri/Cargo.toml').split('\n')
  const start = lines.indexOf('[package]')
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('[')) return undefined
    const version = /^version\s*=\s*"([^"]+)"/.exec(line)?.[1]
    if (version) return version
  }
  return undefined
}

it("names the release from one version, Cargo.toml's", () => {
  const version = cargoVersion()
  expect(version).toMatch(/^\d+\.\d+\.\d+/)
  // Rust reports devot@ and its package version.
  expect(read('src-tauri/src/crash.rs')).toContain(
    'const RELEASE: &str = concat!("devot@", env!("CARGO_PKG_VERSION"));',
  )
  // The UI asks Tauri for the app version, which is Cargo.toml's while
  // tauri.conf.json names none (the app bundle's version comes from it too).
  expect(JSON.parse(read('src-tauri/tauri.conf.json'))).not.toHaveProperty('version')
  expect(read('src/renderer/src/main.tsx')).toContain('`devot@${version}`')
  // Source maps upload under the same name.
  expect(appVersion('.')).toBe(version)
  expect(releaseName('.')).toBe(`devot@${version}`)
  // And npm's copy of the number says the same.
  expect((JSON.parse(read('package.json')) as { version: string }).version).toBe(version)
})

it('names the environment as Rust does', () => {
  // TAURI_ENV_DEBUG reaches the UI, which reads it for the environment.
  expect(read('vite.config.ts')).toMatch(/envPrefix: \[[^\]]*'TAURI_ENV_'/)
  expect(read('src/renderer/src/crash.ts')).toContain(
    "crashEnvironment(import.meta.env['TAURI_ENV_DEBUG']",
  )
  // Rust: development with debug assertions (`tauri dev`, `tauri build --debug`).
  expect(read('src-tauri/src/crash.rs')).toMatch(
    /if cfg!\(debug_assertions\) \{\s*"development"\s*\} else \{\s*"production"\s*\}/,
  )
})
