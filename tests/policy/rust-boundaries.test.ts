import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'

const withoutInlineTests = (code: string) => code.split(/#\[cfg\(test\)\]\s*mod tests\b/)[0]!

it('non-command Rust modules never depend upward on crate::commands', () => {
  const files = listFiles('.', 'src-tauri/src')
    .filter((file) => file.endsWith('.rs'))
    .filter((file) => !file.startsWith('src-tauri/src/commands/'))
    .filter((file) => file !== 'src-tauri/src/lib.rs')
    .filter((file) => !/(^|\/)(?:tests|testing)(\.rs|\/)|_tests\.rs$/.test(file))
  const offenders = files.filter((file) => {
    const code = withoutInlineTests(readFileSync(file, 'utf8'))
    return /\bcrate::commands\b/.test(code)
  })
  expect(offenders).toEqual([])
})

it('foundational Rust modules (locks, data_folder, crash_scrub, keychain, logs, storage) depend on no shell or UI modules', () => {
  const FOUNDATIONS = [
    'src-tauri/src/locks.rs',
    'src-tauri/src/data_folder.rs',
    'src-tauri/src/crash_scrub.rs',
    'src-tauri/src/keychain.rs',
    'src-tauri/src/logs.rs',
    ...listFiles('.', 'src-tauri/src/storage').filter(
      (file) => file.endsWith('.rs') && !/(^|\/)tests\.rs$|_tests\.rs$/.test(file),
    ),
  ]
  const ALLOWED = new Set(['locks', 'storage', 'logs'])
  const offenders = FOUNDATIONS.flatMap((file) => {
    const own = file.startsWith('src-tauri/src/storage/')
      ? 'storage'
      : file.slice('src-tauri/src/'.length, -3)
    const code = withoutInlineTests(readFileSync(file, 'utf8'))
    const deps = [...code.matchAll(/\bcrate::([a-z0-9_]+)/g)]
      .map((m) => m[1]!)
      .filter((dep) => dep !== own && !ALLOWED.has(dep))
    return deps.map((dep) => `${file} -> crate::${dep}`)
  })
  expect(offenders).toEqual([])
})
