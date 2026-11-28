import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'

const withoutInlineTests = (code: string) => code.split(/#\[cfg\(test\)\]\s*mod tests\b/)[0]!

export function crateRootModules(rawCode: string): string[] {
  const code = rawCode.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const roots = new Set<string>()
  for (const m of code.matchAll(/\bcrate::([a-z0-9_]+)/g)) {
    if (m[1] !== 'self') roots.add(m[1]!)
  }
  const groupPrefix = /\bcrate::\s*\{/g
  for (const m of code.matchAll(groupPrefix)) {
    let cursor = m.index + m[0].length
    let depth = 1
    let entryStart = cursor
    while (cursor < code.length && depth > 0) {
      const ch = code[cursor]!
      if (ch === '{') {
        if (depth === 1) {
          const head = code.slice(entryStart, cursor).trim()
          const root = /^([a-z0-9_]+)/.exec(head)?.[1]
          if (root && root !== 'self') roots.add(root)
        }
        depth += 1
      } else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          const entry = code.slice(entryStart, cursor).trim()
          const root = /^([a-z0-9_]+)/.exec(entry)?.[1]
          if (root && root !== 'self') roots.add(root)
        }
      } else if (ch === ',' && depth === 1) {
        const entry = code.slice(entryStart, cursor).trim()
        const root = /^([a-z0-9_]+)/.exec(entry)?.[1]
        if (root && root !== 'self') roots.add(root)
        entryStart = cursor + 1
      }
      cursor += 1
    }
  }
  return [...roots]
}

it('non-command Rust modules never depend upward on crate::commands', () => {
  const files = listFiles('.', 'src-tauri/src')
    .filter((file) => file.endsWith('.rs'))
    .filter((file) => !file.startsWith('src-tauri/src/commands/'))
    .filter((file) => file !== 'src-tauri/src/lib.rs')
    .filter((file) => !/(^|\/)(?:tests|testing)(\.rs|\/)|_tests\.rs$/.test(file))
  const offenders = files.filter((file) => {
    const code = withoutInlineTests(readFileSync(file, 'utf8'))
    return crateRootModules(code).includes('commands')
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
  const ALLOWED = new Set(['locks', 'storage', 'logs', 'crash_reporter'])
  const offenders = FOUNDATIONS.flatMap((file) => {
    const own = file.startsWith('src-tauri/src/storage/')
      ? 'storage'
      : file.slice('src-tauri/src/'.length, -3)
    const code = withoutInlineTests(readFileSync(file, 'utf8'))
    const deps = crateRootModules(code).filter((dep) => dep !== own && !ALLOWED.has(dep))
    return deps.map((dep) => `${file} -> crate::${dep}`)
  })
  expect(offenders).toEqual([])
})

it('extracts root modules from both direct paths and grouped crate::{...} use trees', () => {
  expect(
    crateRootModules('use crate::{commands::{notes, files}, locks, net::fetch, self};'),
  ).toEqual(['commands', 'locks', 'net'])
  expect(crateRootModules('use crate::{net};')).toEqual(['net'])
})
