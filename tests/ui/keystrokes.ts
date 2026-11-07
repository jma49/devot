import type { Locator } from '@playwright/test'

export interface StateLike {
  doc: { length: number; toString(): string }
  selection: { main: { head: number } }
  update(...specs: unknown[]): unknown
}

export interface ViewLike {
  state: StateLike
  dispatch(spec: unknown): void
  focus(): void
  update(transactions: unknown): void
  measure(flush?: boolean): void
}

/** Times each keystroke from now on: the editor's own work and the key to the end of its frame. */
export function watchKeys(content: Locator) {
  return content.evaluate((el) => {
    const view = (el as unknown as { cmTile: { view: ViewLike } }).cmTile.view
    const w = window
    w.devotKeys = []
    let current: { work: number; frame: number } | null = null
    // A call inside another timed one is already in the outer one's time.
    let depth = 0
    const timing = <T>(run: () => T): T => {
      const start = w.performance.now()
      depth++
      try {
        return run()
      } finally {
        depth--
        if (current && depth === 0) current.work += w.performance.now() - start
      }
    }
    for (const name of ['update', 'measure'] as const) {
      const run = view[name].bind(view) as (...args: unknown[]) => void
      view[name] = (...args: unknown[]) => timing(() => run(...args))
    }
    const state = Object.getPrototypeOf(view.state) as StateLike
    const transaction = state.update
    state.update = function (this: StateLike, ...specs: unknown[]) {
      return timing(() => transaction.apply(this, specs))
    }
    w.addEventListener(
      'keydown',
      () => {
        const start = w.performance.now()
        const key = { work: 0, frame: 0 }
        current = key
        w.requestAnimationFrame(() => {
          const after = new w.MessageChannel()
          after.port1.onmessage = () => {
            key.frame = w.performance.now() - start
            w.devotKeys.push(key)
            if (current === key) current = null
          }
          after.port2.postMessage(null)
        })
      },
      true,
    )
  })
}

export const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!
