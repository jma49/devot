// Runs one async job at a time. Inputs that arrive while a job runs are
// collapsed to the newest, so a fast typist never queues stale renders.
export function latestOnly<I, R>(
  job: (input: I) => Promise<R>,
  onResult: (result: R) => void,
  onError: (error: unknown) => void = () => {},
): (input: I) => void {
  let running = false
  let pending: { input: I } | undefined

  const run = (input: I) => {
    running = true
    job(input)
      .then(onResult, onError)
      .finally(() => {
        running = false
        const next = pending
        pending = undefined
        if (next) run(next.input)
      })
  }

  return (input) => {
    if (running) pending = { input }
    else run(input)
  }
}
