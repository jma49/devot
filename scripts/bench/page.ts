// The timing helpers `pnpm bench` runs inside the page. `installBench` is
// serialised into the page by `addInitScript`, so it must stay self-contained:
// no imports and no outer variables.

export interface BenchApi {
  painted(): Promise<void>
  /** Milliseconds until `done()` holds, or -1 after `timeout`. */
  when(done: () => boolean, t0: number, timeout?: number): Promise<number>
  readyAt: number
  keys: { editor: number; preview: number }[]
  expect: string
  scrollList(listLabel: string, frames: number, step: number): Promise<number[]>
}

export function installBench(): void {
  // oxlint-disable-next-line typescript/no-explicit-any
  const w = globalThis as any
  const painted = () =>
    new Promise<void>((resolve) => {
      w.requestAnimationFrame(() => {
        const channel = new w.MessageChannel()
        channel.port1.onmessage = () => resolve()
        channel.port2.postMessage(0)
      })
    })
  const when = (done: () => boolean, t0: number, timeout = 20_000) =>
    new Promise<number>((resolve) => {
      const observer = new w.MutationObserver(() => check())
      const finish = (ms: number) => {
        observer.disconnect()
        resolve(ms)
      }
      const check = () => {
        if (done()) finish(w.performance.now() - t0)
      }
      observer.observe(w.document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      })
      w.setTimeout(() => finish(-1), timeout)
      check()
    })
  const bench = {
    painted,
    when,
    readyAt: -1,
    keys: [] as { editor: number; preview: number }[],
    expect: '',
    async scrollList(listLabel: string, frames: number, step: number) {
      const list = w.document.querySelector(`[role=listbox][aria-label="${listLabel}"]`)
      list.scrollTop = Math.floor((list.scrollHeight - list.clientHeight) / 2)
      await painted()
      const times: number[] = []
      let last = w.performance.now()
      for (let i = 0; i < frames; i += 1) {
        list.scrollTop += step
        await new Promise<void>((resolve) => w.requestAnimationFrame(() => resolve()))
        const now = w.performance.now()
        times.push(now - last)
        last = now
      }
      return times
    },
  }
  w.devotBench = bench

  const mark = () => {
    if (bench.readyAt < 0 && w.document.querySelector('.window[data-ready]'))
      bench.readyAt = w.performance.now()
  }
  new w.MutationObserver(mark).observe(w.document, {
    subtree: true,
    childList: true,
    attributes: true,
  })

  w.addEventListener(
    'keydown',
    () => {
      if (bench.expect === '') return
      const t0 = w.performance.now()
      const entry = { editor: -1, preview: -1 }
      bench.keys.push(entry)
      void painted().then(() => {
        entry.editor = w.performance.now() - t0
      })
      void when(() => {
        const h1 = w.document.querySelector('article[aria-label=Preview] h1')
        return Boolean(h1) && h1.textContent.startsWith(bench.expect)
      }, t0).then((ms) => {
        entry.preview = ms
      })
    },
    true,
  )
}
