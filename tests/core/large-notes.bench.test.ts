import { expect, it } from 'vitest'
import { runLargeNotes, summary } from '../../scripts/bench/large-notes'

it('summarizes nearest-rank p50/p95 and rejects invalid samples', () => {
  expect(summary([4, 1, 3, 2])).toEqual({ n: 4, p50: 2, p95: 4, max: 4 })
  expect(() => summary([])).toThrow('E_BENCH_SAMPLES')
  expect(() => summary([NaN])).toThrow('E_BENCH_SAMPLES')
  expect(() => summary([-1])).toThrow('E_BENCH_SAMPLES')
})

it.runIf(process.env['DEVOT_LARGE_RUN'] === '1')(
  'measures large-note paths',
  { timeout: 600_000 },
  async () => {
    await expect(runLargeNotes()).resolves.toBeUndefined()
  },
)
