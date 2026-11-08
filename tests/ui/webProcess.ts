import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'

// The CPU time of the page's web process on macOS, read from outside the page: the rendering work a
// page cannot time itself (style, layout, paint, event regions) runs on that process's main thread.
// macOS starts the process from launchd, not as the browser's child, so it is found by the CPU it
// burns while the page is busy and does not burn while the page is idle.

const BURN_MS = 1500

const clock = (text: string) =>
  text
    .trim()
    .split(':')
    .map(Number)
    .reduce((sum, part) => sum * 60 + part, 0)

function processSeconds(pid: number): number {
  return clock(execFileSync('ps', ['-o', 'time=', '-p', String(pid)]).toString())
}

/** The CPU seconds of `pid`'s main thread. */
export function mainThreadSeconds(pid: number): number {
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
    if (!line.includes('ms-playwright') || !line.includes('WebContent')) continue
    const pid = Number(/^\s*(\d+)/.exec(line)?.[1])
    try {
      out.set(pid, processSeconds(pid))
    } catch {
      // Gone between the listing and the read.
    }
  }
  return out
}

/** The CPU seconds each web process gained while `during` ran. */
async function gains(during: () => Promise<unknown>): Promise<Map<number, number>> {
  const before = webProcesses()
  await during()
  const out = new Map<number, number>()
  for (const [pid, seconds] of webProcesses()) out.set(pid, seconds - (before.get(pid) ?? seconds))
  return out
}

/**
 * The pid of `page`'s web process, or undefined when it cannot be told apart. Other workers' pages
 * may be busy too, so a candidate must keep up with the page through every burn and rest while the
 * page rests, until one is left.
 */
export async function webProcessOf(page: Page): Promise<number | undefined> {
  let candidates: Set<number> | undefined
  for (let attempt = 0; attempt < 8; attempt++) {
    const busy = await gains(() =>
      page.evaluate((ms) => {
        const end = performance.now() + ms
        while (performance.now() < end) {
          // Burns the page's main thread.
        }
      }, BURN_MS),
    )
    const idle = await gains(() => new Promise((resolve) => setTimeout(resolve, BURN_MS)))
    const kept = [...busy]
      .filter(([pid, seconds]) => seconds >= (0.6 * BURN_MS) / 1000 && (idle.get(pid) ?? 0) < 0.3)
      .map(([pid]) => pid)
    candidates = new Set(candidates ? kept.filter((pid) => candidates!.has(pid)) : kept)
    if (candidates.size === 1) return [...candidates][0]
    if (candidates.size === 0) candidates = undefined
  }
  return undefined
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
