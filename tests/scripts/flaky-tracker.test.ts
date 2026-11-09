import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  issueTitle,
  LABEL,
  newIssueBody,
  plan,
  sightingNote,
  sightings,
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

it('tracks the flakes of main and the merge queue only, with no more access than it needs', () => {
  const workflow = parse(read('.github/workflows/flaky-tracker.yml')) as {
    on: { workflow_run: { workflows: string[]; types: string[] } }
    permissions: Record<string, string>
    jobs: { track: { if: string; permissions: Record<string, string>; steps: { run?: string }[] } }
  }
  expect(workflow.on.workflow_run).toEqual({ workflows: ['CI'], types: ['completed'] })
  expect(workflow.permissions).toEqual({})
  const track = workflow.jobs.track
  expect(track.permissions).toEqual({ actions: 'read', checks: 'read', issues: 'write' })
  expect(track.if).toContain("github.event.workflow_run.head_branch == 'main'")
  expect(track.if).toContain("github.event.workflow_run.event == 'merge_group'")
  expect(track.if).not.toContain('pull_request')
  expect(track.steps.at(-1)?.run).toBe('node scripts/ci/flaky-tracker.ts')
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
