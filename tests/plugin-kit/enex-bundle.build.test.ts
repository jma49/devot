import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { tempDir } from '../support/temp-dirs'

it('keeps the committed ENEX bundle current and builds it deterministically', () => {
  const command = JSON.parse(readFileSync('package.json', 'utf8')).scripts[
    'plugin-enex:build'
  ] as string
  const committed = 'plugins/enex/main.js'
  expect(command).toContain(committed)
  const build = (name: string) => {
    const output = join(tempDir('devot-enex-build-'), name)
    execFileSync('sh', ['-c', command.replaceAll(committed, JSON.stringify(output))], {
      stdio: 'pipe',
    })
    return readFileSync(output, 'utf8')
  }
  const bundled = build('main.js')
  expect(bundled).toBe(readFileSync(committed, 'utf8'))
  expect(build('second.js')).toBe(bundled)
})
