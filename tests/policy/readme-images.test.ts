import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'

// GitHub renders the README from the repository, so each picture has to ship and stay light.
const MAX_BYTES = 2.5 * 1024 * 1024
const readme = readFileSync('README.md', 'utf8')

const localImages = [...readme.matchAll(/\b(?:src|srcset)="([^"]+)"/g)]
  .map((m) => m[1] ?? '')
  .concat([...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? ''))
  .filter((ref) => !/^(?:[a-z]+:)?\/\//i.test(ref) && !ref.startsWith('#'))

it('the README references local images', () => {
  expect(localImages.length).toBeGreaterThan(0)
})

it.each([...new Set(localImages)])('%s exists and is at most 2.5 MB', (ref) => {
  const path = join(dirname('README.md'), ref)
  expect(existsSync(path)).toBe(true)
  expect(statSync(path).size).toBeLessThanOrEqual(MAX_BYTES)
})
