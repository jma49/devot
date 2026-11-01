import { expect, it } from 'vitest'
import { uiDurations } from '../../scripts/ci/ui-timings'

it('combines nested shard reports and counts retries as execution cost', () => {
  expect(
    uiDurations([
      {
        suites: [
          {
            suites: [
              {
                specs: [
                  {
                    file: 'ui/preview.spec.ts',
                    tests: [
                      {
                        results: [
                          { status: 'failed', duration: 5000 },
                          { status: 'passed', duration: 900 },
                        ],
                      },
                      { results: [{ status: 'skipped', duration: 100 }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        suites: [
          {
            specs: [
              {
                file: 'tests/ui/preview.spec.ts',
                tests: [{ results: [{ status: 'passed', duration: 600 }] }],
              },
              {
                file: 'ui-csp/csp.spec.ts',
                tests: [{ results: [{ status: 'passed', duration: 250 }] }],
              },
              {
                file: 'core/preview.test.ts',
                tests: [{ results: [{ status: 'passed', duration: 1000 }] }],
              },
            ],
          },
        ],
      },
    ]),
  ).toEqual({ 'tests/ui-csp/csp.spec.ts': 250, 'tests/ui/preview.spec.ts': 6500 })
})

it.each([-1, NaN, Infinity])('refuses invalid execution durations: %s', (duration) => {
  expect(() =>
    uiDurations([
      {
        suites: [
          {
            specs: [
              { file: 'ui/notes.spec.ts', tests: [{ results: [{ status: 'passed', duration }] }] },
            ],
          },
        ],
      },
    ]),
  ).toThrow('E_UI_DURATION_INVALID')
})
