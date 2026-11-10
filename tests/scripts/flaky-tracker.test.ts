import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  failedJobs,
  GATES,
  health,
  healthBody,
  HEALTH_TITLE,
  issueTitle,
  JOB_KIND,
  LABEL,
  newIssueBody,
  plan,
  ranIn,
  redNote,
  rerunSightings,
  sightingNote,
  sightings,
  verdict,
} from '../../scripts/ci/flaky-tracker'

const read = (path: string) => readFileSync(path, 'utf8')

it('takes only the "Flaky" warnings of a job, whatever reporter wrote them', () => {
  const found = sightings('UI (webkit, 3/14)', [
    { annotation_level: 'warning', title: 'Flaky UI test', message: 'a.spec.ts > drags [webkit]' },
    { annotation_level: 'warning', title: 'Flaky test', message: 'tests/b.test.ts > saves\n' },
    {
      annotation_level: 'warning',
      title: 'Flaky iPhone UI test',
      message: 'DevotUITests.EditorBarsTests testA',
    },
    { annotation_level: 'failure', title: 'Flaky test', message: 'not a warning' },
    { annotation_level: 'warning', title: 'Deprecation', message: 'Node 20' },
    { annotation_level: 'warning', title: null, message: 'untitled' },
    { annotation_level: 'warning', title: 'Flaky test', message: '  ' },
  ])
  expect(found).toEqual([
    { test: 'a.spec.ts > drags [webkit]', kind: 'Flaky UI test', job: 'UI (webkit, 3/14)' },
    { test: 'tests/b.test.ts > saves', kind: 'Flaky test', job: 'UI (webkit, 3/14)' },
    {
      test: 'DevotUITests.EditorBarsTests testA',
      kind: 'Flaky iPhone UI test',
      job: 'UI (webkit, 3/14)',
    },
  ])
})

it("reads a test's name as it was written, not as the annotation escaped it", () => {
  const escaped =
    'ui/a.spec.ts &gt; keeps &quot;a &amp; b&quot; &lt;in&gt; order &#39;x&#39; [webkit]'
  const [found] = sightings('UI (webkit, 2/14)', [
    { annotation_level: 'warning', title: 'Flaky UI test', message: escaped },
  ])
  expect(found?.test).toBe(`ui/a.spec.ts > keeps "a & b" <in> order 'x' [webkit]`)
  // The first issue the tracker opened carries the escaped name: a later sighting still finds it.
  const open = [{ number: 888, title: issueTitle('ui/a.spec.ts &gt; keeps [webkit]') }]
  const again = { test: 'ui/a.spec.ts > keeps [webkit]', kind: 'Flaky UI test', job: 'UI' }
  expect(plan([again], open)).toEqual([{ sighting: again, issue: 888 }])
})

it('names one issue per test, short enough for GitHub', () => {
  expect(issueTitle('tests/b.test.ts > saves')).toBe('Flaky test: tests/b.test.ts > saves')
  expect(issueTitle('x'.repeat(400)).length).toBe(250)
})

it('comments on the open issue a test has and opens one for a new test, once per test per run', () => {
  const a = { test: 'tests/a.test.ts > one', kind: 'Flaky test', job: 'unit' }
  const b = { test: 'tests/b.test.ts > two', kind: 'Flaky test', job: 'unit' }
  const open = [
    { number: 12, title: issueTitle(a.test) },
    { number: 13, title: 'Flaky test: something else' },
  ]
  expect(plan([a, b, { ...a, job: 'policy-check' }], open)).toEqual([
    { sighting: a, issue: 12 },
    { sighting: b, issue: undefined },
  ])
})

it('says where the flake was seen and how the issue is closed', () => {
  const sighting = { test: 'tests/a.test.ts > one', kind: 'Flaky test', job: 'unit' }
  const url = 'https://github.com/o/r/actions/runs/1'
  expect(sightingNote(sighting, url, '0123456789abcdef')).toBe(
    `Passed only on its retry in unit (Flaky test), run ${url} at 0123456.`,
  )
  const body = newIssueBody(sighting, url, '0123456789abcdef')
  expect(body).toContain('`tests/a.test.ts > one`')
  expect(body).toContain('docs/specs/quality.md')
  expect(body).toContain('Close this issue with the pull request that fixes it.')
})

it('runs the failed jobs of a run on main again once, then reports the run as red', () => {
  expect(verdict('push', 'failure', 1)).toBe('rerun')
  expect(verdict('push', 'timed_out', 1)).toBe('rerun')
  expect(verdict('push', 'failure', 2)).toBe('red')
  expect(verdict('push', 'success', 1)).toBe('none')
  expect(verdict('push', 'cancelled', 1)).toBe('none')
  expect(verdict('merge_group', 'failure', 1)).toBe('none')
})

it('reads on a later attempt only the jobs that attempt ran, whatever number GitHub gives the rest', () => {
  // Main's first re-run listed every job under attempt 2, the ones it kept included.
  const before = [
    { id: 1, name: 'UI (webkit, 2/14)', conclusion: 'success', run_attempt: 1 },
    { id: 2, name: 'iPhone UI test (smoke)', conclusion: 'failure', run_attempt: 1 },
    { id: 3, name: 'rust', conclusion: 'failure', run_attempt: 1 },
  ]
  const now = [
    { id: 1, name: 'UI (webkit, 2/14)', conclusion: 'success', run_attempt: 2 },
    { id: 4, name: 'iPhone UI test (smoke)', conclusion: 'success', run_attempt: 2 },
    { id: 5, name: 'rust', conclusion: 'success', run_attempt: 2 },
  ]
  expect(ranIn(now, before).map((job) => job.name)).toEqual(['iPhone UI test (smoke)', 'rust'])
  expect(ranIn(before, undefined)).toEqual(before)
})

it('tracks a job that passed only when it was run again, and never a gate', () => {
  const before = [
    { id: 1, name: 'iPhone UI test (editor)', conclusion: 'failure' },
    { id: 2, name: 'deny', conclusion: 'timed_out' },
    { id: 3, name: 'rust', conclusion: 'failure' },
    { id: 4, name: 'policy', conclusion: 'success' },
  ]
  expect(failedJobs(before)).toEqual(['iPhone UI test (editor)', 'deny'])
  const now = [
    { id: 5, name: 'iPhone UI test (editor)', conclusion: 'success' },
    { id: 6, name: 'deny', conclusion: 'failure' },
    { id: 7, name: 'rust', conclusion: 'success' },
    { id: 4, name: 'policy', conclusion: 'success' },
  ]
  const job = 'iPhone UI test (editor)'
  expect(rerunSightings(before, now)).toEqual([{ test: job, kind: JOB_KIND, job }])
  expect(issueTitle(job, JOB_KIND)).toBe('Flaky job: iPhone UI test (editor)')
  const open = [{ number: 7, title: 'Flaky job: iPhone UI test (editor)' }]
  expect(plan(rerunSightings(before, now), open)[0]?.issue).toBe(7)
  expect(redNote(failedJobs(now), 'https://github.com/o/r/actions/runs/1', '0123456789')).toBe(
    'main is red after its failed jobs ran again: https://github.com/o/r/actions/runs/1 at 0123456. Failed: deny.',
  )
  const ci = parse(read('.github/workflows/ci.yml')) as { jobs: Record<string, unknown> }
  for (const gate of GATES) expect(Object.keys(ci.jobs)).toContain(gate)
})

it("gives main's pass rate, with and without the second attempt, and the flaky tests most seen first", () => {
  const run = (conclusion: string | null, run_attempt: number, id: number) => ({
    conclusion,
    run_attempt,
    html_url: `https://github.com/o/r/actions/runs/${id}`,
  })
  const runs = [
    run('success', 1, 1),
    run('success', 2, 2),
    run('failure', 2, 3),
    run('cancelled', 1, 4),
    run('success', 1, 5),
  ]
  expect(health(runs)).toEqual({
    finished: 4,
    green: 3,
    first: 2,
    red: ['https://github.com/o/r/actions/runs/3'],
  })
  const body = healthBody(
    runs,
    [
      { number: 3, title: HEALTH_TITLE, comments: 9 },
      { number: 12, title: 'Flaky test: a', comments: 0 },
      { number: 13, title: 'Flaky job: deny', comments: 4 },
    ],
    'https://github.com/o/r/actions/runs/5',
  )
  expect(body).toContain(
    "Of main's last 4 finished CI runs, 3 passed (75 %), 2 of them on the first attempt (50 %).",
  )
  expect(body).toContain('- https://github.com/o/r/actions/runs/3')
  expect(body.indexOf('- #13, seen 5 time(s)')).toBeGreaterThan(0)
  expect(body.indexOf('- #13, seen 5 time(s)')).toBeLessThan(body.indexOf('- #12, seen 1 time(s)'))
  expect(body).not.toContain('#3,')
  expect(healthBody([], [], 'u')).toContain("Of main's last 0 finished CI runs, 0 passed (0 %)")
})

it('tracks the flakes of main and the merge queue only, with no more access than it needs', () => {
  const workflow = parse(read('.github/workflows/flaky-tracker.yml')) as {
    on: { workflow_run: { workflows: string[]; types: string[] } }
    permissions: Record<string, string>
    jobs: {
      track: {
        if: string
        permissions: Record<string, string>
        steps: { run?: string; env?: Record<string, string> }[]
      }
    }
  }
  expect(workflow.on.workflow_run).toEqual({ workflows: ['CI'], types: ['completed'] })
  expect(workflow.permissions).toEqual({})
  const track = workflow.jobs.track
  expect(track.permissions).toEqual({ actions: 'write', checks: 'read', issues: 'write' })
  expect(track.if).toContain("github.event.workflow_run.head_branch == 'main'")
  expect(track.if).toContain("github.event.workflow_run.event == 'merge_group'")
  expect(track.if).not.toContain('pull_request')
  expect(track.steps.at(-1)?.run).toBe('node scripts/ci/flaky-tracker.ts')
  expect(Object.keys(track.steps.at(-1)?.env ?? {})).toEqual([
    'GITHUB_TOKEN',
    'RUN_ID',
    'RUN_SHA',
    'RUN_ATTEMPT',
    'RUN_EVENT',
    'RUN_CONCLUSION',
  ])
  expect(LABEL).toBe('flaky')
  // Every flaky reporter's warning title starts with "Flaky", which is what the tracker reads.
  for (const file of [
    'tests/support/flaky-report.ts',
    'scripts/ci/playwright-flaky.ts',
    'scripts/ci/iphone-ui-tests.sh',
    'scripts/ci/devot-screens-tests.sh',
  ]) {
    expect({ file, titled: /::warning title=Flaky[ \w]*::/.test(read(file)) }).toEqual({
      file,
      titled: true,
    })
  }
})
