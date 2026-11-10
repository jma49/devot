import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// CI helper for the `changes` job of .github/workflows/ci.yml: prints the commit of main's newest
// CI run that passed, which a push to main is compared with (scripts/ci/main-plan.sh), or nothing,
// and then the run is a full one.
// The base is the last run that passed, not the push's parent: a newer push cancels main's run, so
// the parent's changes may never have been tested.

export function lastGreen(runs: readonly { head_sha: string }[], current: string) {
  return runs.find((run) => run.head_sha !== current)?.head_sha
}

async function main() {
  const repo = process.env['GITHUB_REPOSITORY']
  const response = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=5`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${process.env['GITHUB_TOKEN'] ?? ''}`,
        'x-github-api-version': '2022-11-28',
      },
    },
  )
  if (!response.ok) {
    console.error(`E_LAST_GREEN_API status=${response.status}`)
    return
  }
  const { workflow_runs } = (await response.json()) as { workflow_runs: { head_sha: string }[] }
  console.log(lastGreen(workflow_runs, process.env['GITHUB_SHA'] ?? '') ?? '')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(() => console.error('E_LAST_GREEN_FAILED'))
}
