import { expect, it } from 'vitest'
import { vitestDurations } from '../../scripts/ci/vitest-timings.ts'

const root = '/repo'

it("records each test file's time from its start to its end, over the previous durations", () => {
  const durations = vitestDurations(
    root,
    [
      {
        testResults: [
          { name: '/repo/tests/a.test.ts', startTime: 1000, endTime: 1250.4 },
          { name: '/repo/src/b.test.tsx', startTime: 10, endTime: 10 },
        ],
      },
      { testResults: [{ name: '/repo/tests/c.test.ts', startTime: 0, endTime: 30 }] },
    ],
    { 'tests/a.test.ts': 9, 'tests/kept.test.ts': 70, 'tests/gone.test.ts': 5 },
    (file) => file !== 'tests/gone.test.ts',
  )
  expect(durations).toEqual({
    'src/b.test.tsx': 1,
    'tests/a.test.ts': 250,
    'tests/c.test.ts': 30,
    'tests/kept.test.ts': 70,
  })
})

it('skips files outside the repository, other files and results without times', () => {
  expect(
    vitestDurations(root, [
      {
        testResults: [
          { name: '/elsewhere/x.test.ts', startTime: 0, endTime: 5 },
          { name: '/repo/tests/ui/a.spec.ts', startTime: 0, endTime: 5 },
          { name: '/repo/tests/a.test.ts' },
        ],
      },
    ]),
  ).toEqual({})
})

it('fails on a time that runs backwards', () => {
  expect(() =>
    vitestDurations(root, [
      { testResults: [{ name: '/repo/tests/a.test.ts', startTime: 5, endTime: 1 }] },
    ]),
  ).toThrow('E_VITEST_DURATION_INVALID tests/a.test.ts')
})
