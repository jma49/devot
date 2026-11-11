import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// CI helper for .github/workflows/flaky-tracker.yml: after a CI run on main or in the merge queue,
// every test that passed only on its retry (a "Flaky" warning annotation from
// tests/support/flaky-report.ts, scripts/ci/playwright-flaky.ts or the iPhone test scripts) gets an
// open issue labelled `flaky`, one per test, and each later run that sees it adds a comment, so the
// count of sightings says which flake to fix first.
// A failed run on main has its failed jobs run again, once: a job that passes then is tracked the
// same way, and a run that is still red is reported on the "CI health" issue, whose text gives
// main's pass rate over its last runs.

export const LABEL = 'flaky'
export const HEALTH_TITLE = 'CI health'
export const JOB_KIND = 'Flaky job'
/** Jobs that only repeat the result of the jobs they need. */
export const GATES: readonly string[] = ['web', 'rust']
const MAX_ATTEMPTS = 2
const HEALTH_RUNS = 30

export type Annotation = { annotation_level: string; title: string | null; message: string }
export type Sighting = { test: string; kind: string; job: string }
export type Issue = { number: number; title: string; comments?: number }
export type Job = { id: number; name: string; conclusion: string | null; run_attempt?: number }
export type Run = { conclusion: string | null; run_attempt: number; html_url: string }

export function sightings(job: string, annotations: readonly Annotation[]): Sighting[] {
  return annotations
    .filter((a) => a.annotation_level === 'warning' && (a.title ?? '').startsWith('Flaky'))
    .map((a) => ({ test: a.message.trim(), kind: a.title ?? 'Flaky', job }))
    .filter((s) => s.test.length > 0)
}

export function issueTitle(test: string, kind = 'Flaky test'): string {
  const title = `${kind === JOB_KIND ? JOB_KIND : 'Flaky test'}: ${test}`
  return title.length > 250 ? `${title.slice(0, 249)}…` : title
}

const failed = (job: Job) => job.conclusion === 'failure' || job.conclusion === 'timed_out'

export function failedJobs(jobs: readonly Job[]): string[] {
  return jobs.filter((job) => failed(job) && !GATES.includes(job.name)).map((job) => job.name)
}

/** The jobs that failed on the attempt before and passed when they were run again. */
export function rerunSightings(before: readonly Job[], now: readonly Job[]): Sighting[] {
  const passed = new Set(now.filter((job) => job.conclusion === 'success').map((job) => job.name))
  return failedJobs(before)
    .filter((name) => passed.has(name))
    .map((name) => ({ test: name, kind: JOB_KIND, job: name }))
}

/** What a finished run asks for: its failed jobs once more, a report that main is red, or nothing. */
export function verdict(event: string, conclusion: string, attempt: number) {
  if (event !== 'push' || (conclusion !== 'failure' && conclusion !== 'timed_out')) return 'none'
  return attempt < MAX_ATTEMPTS ? 'rerun' : 'red'
}

export function health(runs: readonly Run[]) {
  const finished = runs.filter((run) => run.conclusion !== 'cancelled' && run.conclusion !== null)
  const green = finished.filter((run) => run.conclusion === 'success')
  return {
    finished: finished.length,
    green: green.length,
    first: green.filter((run) => run.run_attempt === 1).length,
    red: finished.filter((run) => run.conclusion !== 'success').map((run) => run.html_url),
  }
}

export function healthBody(runs: readonly Run[], open: readonly Issue[], runUrl: string): string {
  const { finished, green, first, red } = health(runs)
  const percent = (n: number) => (finished === 0 ? 0 : Math.round((n / finished) * 100))
  const flaky = open
    .filter((issue) => issue.title !== HEALTH_TITLE)
    .toSorted((a, b) => (b.comments ?? 0) - (a.comments ?? 0))
  return [
    `Of main's last ${finished} finished CI runs, ${green} passed (${percent(green)} %), ${first} of them on the first attempt (${percent(first)} %).`,
    '',
    red.length === 0 ? 'No run is red.' : 'Red runs:',
    ...red.map((url) => `- ${url}`),
    '',
    flaky.length === 0 ? 'No flaky test is open.' : 'Open flaky tests, most seen first:',
    ...flaky.map((issue) => `- #${issue.number}, seen ${(issue.comments ?? 0) + 1} time(s)`),
    '',
    `Written by ${runUrl}; a run that stays red after its failed jobs ran again is reported in a comment below (docs/specs/quality.md, Flaky tests).`,
  ].join('\n')
}

export function redNote(jobs: readonly string[], runUrl: string, sha: string): string {
  return `main is red after its failed jobs ran again: ${runUrl} at ${sha.slice(0, 7)}. Failed: ${jobs.join(', ')}.`
}

export function sightingNote(sighting: Sighting, runUrl: string, sha: string): string {
  return `Passed only on its retry in ${sighting.job} (${sighting.kind}), run ${runUrl} at ${sha.slice(0, 7)}.`
}

export function newIssueBody(sighting: Sighting, runUrl: string, sha: string): string {
  return [
    `\`${sighting.test}\` failed and then passed on CI's retry, so the run stayed green.`,
    '',
    sightingNote(sighting, runUrl, sha),
    '',
    'Each later sighting on main or in the merge queue adds a comment here.',
    "Fix the cause (docs/specs/quality.md, Flaky tests); don't skip or quarantine the test.",
    'Close this issue with the pull request that fixes it.',
  ].join('\n')
}

/**
 * The open issues with the ones this run just opened: GitHub's list of issues lags a new issue by
 * seconds, and the health issue written right after left them out until the next run.
 */
export function withOpened(listed: readonly Issue[], opened: readonly Issue[]): Issue[] {
  const known = new Set(listed.map((issue) => issue.number))
  return [...listed, ...opened.filter((issue) => !known.has(issue.number))]
}

/** For each sighting, the open issue that already tracks its test, or none. */
export function plan(found: readonly Sighting[], open: readonly Issue[]) {
  const byTitle = new Map(open.map((issue) => [issue.title, issue.number]))
  const seen = new Set<string>()
  return found
    .filter((s) => !seen.has(s.test) && seen.add(s.test))
    .map((sighting) => ({
      sighting,
      issue: byTitle.get(issueTitle(sighting.test, sighting.kind)),
    }))
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${process.env['GITHUB_TOKEN'] ?? ''}`,
      'x-github-api-version': '2022-11-28',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
  })
  if (!response.ok) throw new Error(`E_FLAKY_TRACKER_API status=${response.status} path=${path}`)
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

async function main() {
  const repo = process.env['GITHUB_REPOSITORY']
  const run = process.env['RUN_ID']
  const sha = process.env['RUN_SHA'] ?? ''
  const attempt = Number(process.env['RUN_ATTEMPT'] ?? 1)
  if (!repo || !run) throw new Error('E_FLAKY_TRACKER_ENV')
  const runs = `/repos/${repo}/actions/runs/${run}`
  const runUrl = `https://github.com/${repo}/actions/runs/${run}`
  const jobsOf = async (path: string) =>
    (await api<{ jobs: Job[] }>(`${path}/jobs?per_page=100`)).jobs
  const jobs = await jobsOf(`${runs}/attempts/${attempt}`)
  const found: Sighting[] = []
  // A job this attempt did not run again keeps the annotations an earlier attempt already counted.
  for (const job of jobs.filter((each) => (each.run_attempt ?? attempt) === attempt)) {
    const annotations = await api<Annotation[]>(
      `/repos/${repo}/check-runs/${job.id}/annotations?per_page=100`,
    )
    found.push(...sightings(job.name, annotations))
  }
  if (attempt > 1) {
    found.push(...rerunSightings(await jobsOf(`${runs}/attempts/${attempt - 1}`), jobs))
  }
  console.log(`flaky-tracker: ${found.length} sighting(s) in run ${run} attempt ${attempt}`)
  const issues = `/repos/${repo}/issues`
  const open = await api<Issue[]>(`${issues}?labels=${LABEL}&state=open&per_page=100`)
  const post = (path: string, body: unknown, method = 'POST') =>
    api<Issue>(path, { method, body: JSON.stringify(body) })
  const opened: Issue[] = []
  for (const { sighting, issue } of plan(found, open)) {
    if (issue) {
      await post(`${issues}/${issue}/comments`, { body: sightingNote(sighting, runUrl, sha) })
      console.log(`flaky-tracker: issue ${issue} seen again`)
    } else {
      const made = await post(issues, {
        title: issueTitle(sighting.test, sighting.kind),
        body: newIssueBody(sighting, runUrl, sha),
        labels: [LABEL, 'bug'],
      })
      opened.push({ number: made.number, title: made.title, comments: 0 })
      console.log(`flaky-tracker: issue ${made.number} opened`)
    }
  }

  const event = process.env['RUN_EVENT'] ?? ''
  const asks = verdict(event, process.env['RUN_CONCLUSION'] ?? '', attempt)
  if (asks === 'rerun') {
    await post(`${runs}/rerun-failed-jobs`, {})
    console.log(`flaky-tracker: run ${run} has its failed jobs run again`)
    return
  }
  if (event !== 'push') return
  const last = await api<{ workflow_runs: Run[] }>(
    `/repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=${HEALTH_RUNS}`,
  )
  const tracked = withOpened(
    await api<Issue[]>(`${issues}?labels=${LABEL}&state=open&per_page=100`),
    opened,
  )
  const body = healthBody(last.workflow_runs, tracked, runUrl)
  const board =
    tracked.find((issue) => issue.title === HEALTH_TITLE)?.number ??
    (await post(issues, { title: HEALTH_TITLE, body, labels: [LABEL] })).number
  await post(`${issues}/${board}`, { body }, 'PATCH')
  if (asks === 'red') {
    await post(`${issues}/${board}/comments`, { body: redNote(failedJobs(jobs), runUrl, sha) })
  }
  console.log(`flaky-tracker: issue ${board} holds main's pass rate`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
