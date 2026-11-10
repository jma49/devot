import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// CI helper: waits until this run has the artifact another job uploads, so a job can start with
// that job (and boot its simulator meanwhile) instead of after it: a job that `needs` another
// starts only once the whole of it has ended. It stops at once when the uploading job ended
// without the artifact. `node scripts/ci/wait-for-artifact.ts <artifact> <job name>`, with the
// run from GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_TOKEN (`actions: read`).

export type Seen = {
  readonly artifact: boolean
  /** The uploading job's conclusion once it has ended; undefined while it waits or runs. */
  readonly conclusion: string | undefined
}

export type Verdict = 'ready' | 'wait' | 'failed'

export function verdict(seen: Seen): Verdict {
  if (seen.artifact) return 'ready'
  return seen.conclusion === undefined ? 'wait' : 'failed'
}

export async function waitFor(
  look: () => Promise<Seen>,
  options: { readonly everyMs: number; readonly limitMs: number },
  sleep: (ms: number) => Promise<void>,
): Promise<{ verdict: Verdict; waitedMs: number; conclusion: string | undefined }> {
  let waitedMs = 0
  for (;;) {
    const seen = await look()
    const now = verdict(seen)
    if (now !== 'wait' || waitedMs >= options.limitMs) {
      return { verdict: now, waitedMs, conclusion: seen.conclusion }
    }
    await sleep(options.everyMs)
    waitedMs += options.everyMs
  }
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${process.env['GITHUB_TOKEN'] ?? ''}`,
      'x-github-api-version': '2022-11-28',
    },
  })
  if (!response.ok) throw new Error(`E_WAIT_ARTIFACT_API status=${response.status} path=${path}`)
  return (await response.json()) as T
}

async function main() {
  const [artifact, job] = process.argv.slice(2)
  const repo = process.env['GITHUB_REPOSITORY']
  const run = process.env['GITHUB_RUN_ID']
  if (!artifact || !job || !repo || !run) throw new Error('E_WAIT_ARTIFACT_ARGS')
  const look = async (): Promise<Seen> => {
    const found = await api<{ total_count: number }>(
      `/repos/${repo}/actions/runs/${run}/artifacts?name=${encodeURIComponent(artifact)}`,
    )
    if (found.total_count > 0) return { artifact: true, conclusion: undefined }
    const { jobs } = await api<{ jobs: { name: string; conclusion: string | null }[] }>(
      `/repos/${repo}/actions/runs/${run}/jobs?filter=latest&per_page=100`,
    )
    const ended = jobs.find((j) => j.name === job)?.conclusion ?? undefined
    if (ended === undefined) return { artifact: false, conclusion: undefined }
    // The job may have ended between the two requests, with the artifact uploaded.
    const again = await api<{ total_count: number }>(
      `/repos/${repo}/actions/runs/${run}/artifacts?name=${encodeURIComponent(artifact)}`,
    )
    return { artifact: again.total_count > 0, conclusion: ended }
  }
  const result = await waitFor(look, { everyMs: 10_000, limitMs: 40 * 60_000 }, (ms) => {
    return new Promise((done) => setTimeout(done, ms))
  })
  const seconds = Math.round(result.waitedMs / 1000)
  if (result.verdict === 'ready') return console.log(`${artifact}: ready after ${seconds}s`)
  const why = result.verdict === 'failed' ? `job=${result.conclusion}` : 'timeout'
  console.error(`E_WAIT_ARTIFACT_MISSING artifact=${artifact} ${why} waited=${seconds}s`)
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
