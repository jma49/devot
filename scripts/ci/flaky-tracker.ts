import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// CI helper for .github/workflows/flaky-tracker.yml: after a CI run on main or in the merge queue,
// every test that passed only on its retry (a "Flaky" warning annotation from
// tests/support/flaky-report.ts, scripts/ci/playwright-flaky.ts or the iPhone test scripts) gets an
// open issue labelled `flaky`, one per test, and each later run that sees it adds a comment, so the
// count of sightings says which flake to fix first.

export const LABEL = 'flaky'
const TITLE_PREFIX = 'Flaky test: '

export type Annotation = { annotation_level: string; title: string | null; message: string }
export type Sighting = { test: string; kind: string; job: string }
export type Issue = { number: number; title: string }

export function sightings(job: string, annotations: readonly Annotation[]): Sighting[] {
  return annotations
    .filter((a) => a.annotation_level === 'warning' && (a.title ?? '').startsWith('Flaky'))
    .map((a) => ({ test: a.message.trim(), kind: a.title ?? 'Flaky', job }))
    .filter((s) => s.test.length > 0)
}

export function issueTitle(test: string): string {
  const title = `${TITLE_PREFIX}${test}`
  return title.length > 250 ? `${title.slice(0, 249)}…` : title
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

/** For each sighting, the open issue that already tracks its test, or none. */
export function plan(found: readonly Sighting[], open: readonly Issue[]) {
  const byTitle = new Map(open.map((issue) => [issue.title, issue.number]))
  const seen = new Set<string>()
  return found
    .filter((s) => !seen.has(s.test) && seen.add(s.test))
    .map((sighting) => ({ sighting, issue: byTitle.get(issueTitle(sighting.test)) }))
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
  return (await response.json()) as T
}

async function main() {
  const repo = process.env['GITHUB_REPOSITORY']
  const run = process.env['RUN_ID']
  const sha = process.env['RUN_SHA'] ?? ''
  if (!repo || !run) throw new Error('E_FLAKY_TRACKER_ENV')
  const runUrl = `https://github.com/${repo}/actions/runs/${run}`
  const { jobs } = await api<{ jobs: { id: number; name: string }[] }>(
    `/repos/${repo}/actions/runs/${run}/jobs?filter=latest&per_page=100`,
  )
  const found: Sighting[] = []
  for (const job of jobs) {
    const annotations = await api<Annotation[]>(
      `/repos/${repo}/check-runs/${job.id}/annotations?per_page=100`,
    )
    found.push(...sightings(job.name, annotations))
  }
  console.log(`flaky-tracker: ${found.length} sighting(s) in run ${run}`)
  if (found.length === 0) return
  const open = await api<Issue[]>(`/repos/${repo}/issues?labels=${LABEL}&state=open&per_page=100`)
  for (const { sighting, issue } of plan(found, open)) {
    if (issue) {
      await api(`/repos/${repo}/issues/${issue}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: sightingNote(sighting, runUrl, sha) }),
      })
      console.log(`flaky-tracker: issue ${issue} seen again`)
    } else {
      const made = await api<Issue>(`/repos/${repo}/issues`, {
        method: 'POST',
        body: JSON.stringify({
          title: issueTitle(sighting.test),
          body: newIssueBody(sighting, runUrl, sha),
          labels: [LABEL, 'bug'],
        }),
      })
      console.log(`flaky-tracker: issue ${made.number} opened`)
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
