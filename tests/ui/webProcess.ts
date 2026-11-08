import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// The CPU time of the page's web process, read from outside the page: the rendering work a page cannot
// time itself (style, layout, paint, event regions) runs on that process's main thread. macOS starts
// the process from launchd, not as the browser's child, so it is found by the CPU a busy page burns.

const linux = process.platform === 'linux'
const ticks = linux ? Number(execFileSync('getconf', ['CLK_TCK']).toString().trim()) : 0

const clock = (text: string) =>
  text
    .trim()
    .split(':')
    .map(Number)
    .reduce((sum, part) => sum * 60 + part, 0)

/** The user and system seconds in a `/proc/.../stat` line. */
function procSeconds(path: string): number {
  const fields = readFileSync(path, 'utf8').split(') ')[1]!.split(' ')
  return (Number(fields[11]) + Number(fields[12])) / ticks
}

function processSeconds(pid: number): number {
  if (linux) return procSeconds(`/proc/${pid}/stat`)
  return clock(execFileSync('ps', ['-o', 'time=', '-p', String(pid)]).toString())
}

/** The CPU seconds of `pid`'s main thread. */
export function mainThreadSeconds(pid: number): number {
  if (linux) return procSeconds(`/proc/${pid}/task/${pid}/stat`)
  const [, main] = execFileSync('ps', ['-M', '-p', String(pid)])
    .toString()
    .trim()
    .split('\n')
  const times = /(\d+:\d+(?::\d+)?\.\d+)\s+(\d+:\d+(?::\d+)?\.\d+)/.exec(main ?? '')
  if (!times) throw new Error('E_TEST_THREAD_TIMES')
  return clock(times[1]!) + clock(times[2]!)
}

function webProcesses(): Map<number, number> {
  const out = new Map<number, number>()
  const list = execFileSync('ps', ['-axo', 'pid=,command=']).toString()
  for (const line of list.split('\n')) {
    if (!line.includes('ms-playwright') || !/WebContent|WebKitWebProcess/.test(line)) continue
    const pid = Number(/^\s*(\d+)/.exec(line)?.[1])
    try {
      out.set(pid, processSeconds(pid))
    } catch {
      // Gone between the listing and the read.
    }
  }
  return out
}

/** The pid of `page`'s web process: the one that gains most of the CPU the page burns. */
export async function webProcessOf(page: Page): Promise<number> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = webProcesses()
    await page.evaluate(() => {
      const end = performance.now() + 1500
      while (performance.now() < end) {
        // Burns the page's main thread.
      }
    })
    const gains = [...webProcesses()]
      .map(([pid, seconds]) => [pid, seconds - (before.get(pid) ?? seconds)] as const)
      .sort((a, b) => b[1] - a[1])
    const [best, next] = gains
    if (best && best[1] >= 1 && (!next || next[1] < best[1] / 2)) return best[0]
  }
  throw new Error('E_TEST_WEB_PROCESS')
}

/** Waits until `pid` has used under 8% of a core for a second, at most `timeout` ms. */
export async function quietProcess(pid: number, timeout = 60_000): Promise<void> {
  const start = Date.now()
  let last = processSeconds(pid)
  let since: number | undefined
  while (Date.now() - start < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const now = processSeconds(pid)
    const busy = (now - last) / 0.25
    last = now
    if (busy >= 0.08) since = undefined
    else if ((since ??= Date.now() - 250) <= Date.now() - 1000) return
  }
}
