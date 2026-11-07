// The worker loads these engines' code on first use (issue 742), so a start waits for a load
// that a stop, or another start, may overtake.

/**
 * An engine that starts once its code loads. A stop, or a later start, made while the code loads
 * wins: the earlier start makes nothing.
 */
export function lazyEngine<M, E extends { start(): void; stop(): Promise<void> }>(
  load: () => Promise<M>,
) {
  let engine: E | undefined
  let starts = 0
  return {
    get current(): E | undefined {
      return engine
    },
    async start(make: (loaded: M) => E): Promise<void> {
      if (engine) return
      const start = ++starts
      const loaded = await load()
      if (engine || start !== starts) return
      engine = make(loaded)
      engine.start()
    },
    async stop(): Promise<void> {
      starts += 1
      const was = engine
      engine = undefined
      await was?.stop()
    },
  }
}

/** One thing made once its code loads; starts made while it loads all wait for that one. */
export function lazyOnce<M, T>(load: () => Promise<M>) {
  let made: T | undefined
  let making: Promise<void> | undefined
  return {
    get current(): T | undefined {
      return made
    },
    start(make: (loaded: M) => T): Promise<void> {
      making ??= load()
        .then((loaded) => {
          made = make(loaded)
        })
        .catch((error: unknown) => {
          making = undefined
          throw error
        })
      return making
    },
  }
}

/** Remembers the last task run, so a stop can wait for it whatever its outcome. */
export function trackedRuns() {
  let last: Promise<unknown> = Promise.resolve()
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const run = task()
      last = run.catch(() => undefined)
      return run
    },
    settled: async (): Promise<void> => {
      await last
    },
  }
}
