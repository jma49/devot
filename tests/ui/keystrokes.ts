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
    const timed = (name: 'update' | 'measure') => {
      const run = view[name].bind(view) as (...args: unknown[]) => void
      view[name] = (...args: unknown[]) => {
        const start = w.performance.now()
        try {
          run(...args)
        } finally {
          if (current) current.work += w.performance.now() - start
        }
      }
    }
    timed('update')
    timed('measure')
    const state = Object.getPrototypeOf(view.state) as StateLike
    const transaction = state.update
    state.update = function (this: StateLike, ...specs: unknown[]) {
      const start = w.performance.now()
      try {
        return transaction.apply(this, specs)
      } finally {
        if (current) current.work += w.performance.now() - start
      }
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
