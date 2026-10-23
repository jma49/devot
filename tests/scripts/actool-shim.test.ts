import { execFileSync } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { tempDir } from '../support/temp-dirs'

// tauri-apps/tauri#15315: under the Node CLI the bundler starts actool with stdin closed, and
// actool then fails to compile the Icon Composer document. The shim gives it an empty stdin.

const SHIM = 'scripts/shims/actool'

it('runs actool through xcrun with every argument and an empty stdin', () => {
  const bin = tempDir('devot-actool-')
  writeFileSync(
    join(bin, 'xcrun'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@"',
      'if IFS= read -r line; then echo "stdin: $line"; else echo "stdin: empty"; fi',
    ].join('\n'),
  )
  chmodSync(join(bin, 'xcrun'), 0o755)
  const out = execFileSync(SHIM, ['Icon.icon', '--compile', 'out dir'], {
    env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
    input: 'a line the shim must not pass on\n',
    encoding: 'utf8',
  })
  expect(out.split('\n')).toEqual([
    'actool',
    'Icon.icon',
    '--compile',
    'out dir',
    'stdin: empty',
    '',
  ])
})

it('comes first on PATH for every pnpm tauri command, so local and release builds use it', () => {
  const scripts = (
    JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
  ).scripts
  const tauri = scripts['tauri'] ?? ''
  expect(tauri.endsWith(' tauri')).toBe(true)
  const found = execFileSync(
    'sh',
    ['-c', `${tauri.slice(0, -' tauri'.length)} sh -c 'command -v actool'`],
    {
      encoding: 'utf8',
    },
  ).trim()
  expect(found).toBe(resolve(SHIM))
  expect(scripts['build']).toMatch(/^pnpm tauri build\b/)
  expect(scripts['build:debug']).toMatch(/^pnpm tauri build\b/)
})
