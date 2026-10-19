import type { Page } from '@playwright/test'

/**
 * Makes the core's replies to the calls named in `late` come 500 ms late, as on a busy machine.
 * Once `failCoreCalls` names a call, that call fails in the core.
 */
export async function slowCore(page: Page, late: string[]): Promise<void> {
  await page.addInitScript((lateCalls: string[]) => {
    const failing = window as { devotFailCalls?: string[] }
    const delayed = new Set<unknown>()
    const post = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (
      this: Worker,
      ...args: Parameters<Worker['postMessage']>
    ) {
      const data = args[0] as { id?: unknown; path?: unknown[] } | undefined
      const call = data?.path?.length === 1 ? data.path[0] : undefined
      if (typeof call === 'string' && lateCalls.includes(call)) delayed.add(data?.id)
      if (data && typeof call === 'string' && failing.devotFailCalls?.includes(call)) {
        data.path = ['callMadeToFail']
      }
      post.apply(this, args)
    } as Worker['postMessage']
    const listen = Worker.prototype.addEventListener
    Worker.prototype.addEventListener = function (
      this: Worker,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type !== 'message' || typeof listener !== 'function') {
        return listen.call(this, type, listener, options)
      }
      const later = (event: Event) => {
        const id = (event as MessageEvent<{ id?: unknown }>).data?.id
        if (!delayed.has(id)) return listener.call(this, event)
        // Every listener on the worker sees the reply late; the id is done after.
        setTimeout(() => {
          delayed.delete(id)
          listener.call(this, event)
        }, 500)
      }
      return listen.call(this, type, later, options)
    }
  }, late)
}

export async function failCoreCalls(page: Page, calls: string[]): Promise<void> {
  await page.evaluate((names) => {
    ;(window as { devotFailCalls?: string[] }).devotFailCalls = names
  }, calls)
}
