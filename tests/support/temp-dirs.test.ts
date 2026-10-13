import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { removeTempDirs, tempDir } from './temp-dirs'

it('removes the folders it made, with what is in them', () => {
  const a = tempDir('devot-temp-test-')
  const b = tempDir('devot-temp-test-')
  writeFileSync(join(a, 'devot.sqlite'), 'x')
  expect(a).not.toBe(b)
  expect(existsSync(a) && existsSync(b)).toBe(true)
  removeTempDirs()
  expect(existsSync(a) || existsSync(b)).toBe(false)
  // A second run has nothing left to remove.
  expect(() => removeTempDirs()).not.toThrow()
})
