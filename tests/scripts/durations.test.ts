import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { readDurations } from '../../scripts/ci/durations.ts'
import { tempDir } from '../support/temp-dirs'

it('reads the first usable file and falls back past a missing or broken one', () => {
  const dir = tempDir('devot-durations-')
  const broken = join(dir, 'broken.json')
  const negative = join(dir, 'negative.json')
  const good = join(dir, 'good.json')
  writeFileSync(broken, '{')
  writeFileSync(negative, '{"a.test.ts": -1}')
  writeFileSync(good, '{"a.test.ts": 12}')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(readDurations(undefined, join(dir, 'missing.json'), broken, negative, good)).toEqual({
    'a.test.ts': 12,
  })
  expect(error.mock.calls.map(([line]) => String(line).split(' ')[0])).toEqual([
    'E_DURATIONS_UNREADABLE',
    'E_DURATIONS_UNREADABLE',
  ])
  expect(readDurations(join(dir, 'missing.json'))).toEqual({})
  error.mockRestore()
})
