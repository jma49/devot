import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { tempDir } from '../support/temp-dirs'

// The published command is one bundled script, built from the app's own sources; it must run on Node alone.

it('builds a command that starts, checks and packs a plugin', () => {
  const dir = tempDir('devot-kit-build-')
  const script = join(dir, 'devot-plugin.js')
  const build = JSON.parse(readFileSync('package.json', 'utf8')).scripts[
    'plugin-kit:build'
  ] as string
  execFileSync('sh', ['-c', build.replace('plugin-kit/dist/devot-plugin.js', script)], {
    stdio: 'pipe',
  })
  expect(readFileSync(script, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true)
  const kit = (...args: string[]) =>
    execFileSync(process.execPath, [script, ...args], { cwd: dir }).toString()
  expect(kit('new', 'tools')).toMatch(/^Made /)
  expect(kit('validate', 'tools')).toMatch(/^com\.example\.tools 0\.1\.0: valid for plugin API 2/)
  expect(kit('pack', 'tools')).toMatch(/^Packed 3 files into /)
})
