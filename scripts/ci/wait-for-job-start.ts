import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitFor } from './wait-for-artifact.ts'

// CI helper: waits until another job of this run holds a runner, so the jobs that need this one
// take a runner only after it does. The account runs five macOS jobs at a time: the iPhone UI
// shards started beside the app build took runners while the build was still queued and held them
// for up to 45 minutes waiting for its artifact. `node scripts/ci/wait-for-job-start.ts <job name>`,
// with the run from GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_TOKEN (`actions: read`).

export function hasStarted(status: string | undefined): boolean {
  return status === 'in_progress' || status === 'completed'
}

async function main() {
  const [job] = process.argv.slice(2)
  const repo = process.env['GITHUB_REPOSITORY']
  const run = process.env['GITHUB_RUN_ID']
  if (!job || !repo || !run) throw new Error('E_WAIT_JOB_ARGS')
  const look = async () => {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs/${run}/jobs?filter=latest&per_page=100`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${process.env['GITHUB_TOKEN'] ?? ''}`,
          'x-github-api-version': '2022-11-28',
        },
      },
    )
    if (!response.ok) throw new Error(`E_WAIT_JOB_API status=${response.status}`)
    const { jobs } = (await response.json()) as { jobs: { name: string; status: string }[] }
    // waitFor's "artifact" stands for the started job here.
    return { artifact: hasStarted(jobs.find((j) => j.name === job)?.status), conclusion: undefined }
  }
  const result = await waitFor(
    look,
    { everyMs: 10_000, limitMs: 110 * 60_000 },
    (ms) => new Promise((done) => setTimeout(done, ms)),
    (error) =>
      console.log(`${job}: a request failed (${error instanceof Error ? error.name : 'error'})`),
  )
  const seconds = Math.round(result.waitedMs / 1000)
  if (result.verdict === 'ready') return console.log(`${job}: started after ${seconds}s`)
  console.error(`E_WAIT_JOB_NOT_STARTED waited=${seconds}s`)
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
