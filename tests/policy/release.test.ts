import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { appVersion, releaseName } from '../../scripts/sentry/upload'

const read = (path: string) => readFileSync(path, 'utf8')

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
  expect(read('src-tauri/src/crash.rs')).toContain(
    'const RELEASE: &str = concat!("devot@", env!("CARGO_PKG_VERSION"));',
  )
  // The iPhone build reads its version only from tauri.conf.json (1.0.0 without it), so it points at package.json.
  expect(JSON.parse(read('src-tauri/tauri.conf.json'))).toHaveProperty('version', '../package.json')
  expect(read('src/renderer/src/main.tsx')).toContain('`devot@${version}`')
  expect(appVersion('.')).toBe(version)
  expect(releaseName('.')).toBe(`devot@${version}`)
  expect((JSON.parse(read('package.json')) as { version: string }).version).toBe(version)
})

it('names the environment as Rust does', () => {
  expect(read('vite.config.ts')).toMatch(/envPrefix: \[[^\]]*'TAURI_ENV_'/)
  expect(read('src/renderer/src/crash.ts')).toContain(
    "crashEnvironment(import.meta.env['TAURI_ENV_DEBUG']",
  )
  // Rust: development with debug assertions (`tauri dev`, `tauri build --debug`).
  expect(read('src-tauri/src/crash.rs')).toMatch(
    /if cfg!\(debug_assertions\) \{\s*"development"\s*\} else \{\s*"production"\s*\}/,
  )
})
