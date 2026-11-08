// The core worker's imports (core.worker.ts). A quit holds the running one before its next file
// while the windows save, so a quit called off lets it go on and a quit that goes on ends it there.
import { trackedRuns } from './lazyStart'

type Stopped = () => boolean | Promise<boolean>

export function importRuns() {
  const runs = trackedRuns()
  let stopping = false
  let hold: ReturnType<typeof held> | undefined
  const stopped: Stopped = () => {
    if (!hold) return stopping
    hold.reached()
    return hold.released.then(() => stopping)
  }
  const resume = () => {
    hold?.release()
    hold = undefined
  }
  return {
    run<T>(task: (stopped: Stopped) => Promise<T>): Promise<T> {
      stopping = false
      return runs.run(() => task(stopped))
    },
    /** Resolves once the running import waits before its next file, or has ended, or none runs. */
    async hold(): Promise<void> {
      hold ??= held()
      await Promise.race([runs.settled(), hold.waiting])
    },
    resume,
    /** Ends the running import before its next file, held or not; resolves once it has. */
    async stop(): Promise<void> {
      stopping = true
      resume()
      await runs.settled()
    },
  }
}

function held() {
  let release = () => {}
  let reached = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  const waiting = new Promise<void>((resolve) => (reached = resolve))
  return { released, release, waiting, reached }
}
