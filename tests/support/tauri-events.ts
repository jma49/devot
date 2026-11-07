import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'

type Answer = (cmd: string, args: Record<string, unknown>) => unknown

/**
 * Tauri's IPC for a hook test: listeners register once `release` is called while `hold` is on, so
 * a test can unmount a component before its listeners exist. Other commands land in `invoked` and
 * get `answer`'s reply.
 */
export function mockTauri(answer: Answer = () => null) {
  const invoked: string[] = []
  const listeners = new Map<string, number[]>()
  const asked = new Map<string, number>()
  const waiting: (() => void)[] = []
  let holding = false
  mockWindows('main')
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>
    if (cmd === 'plugin:event|listen') {
      const event = args['event'] as string
      const handler = args['handler'] as number
      asked.set(event, (asked.get(event) ?? 0) + 1)
      const register = () => {
        listeners.set(event, [...(listeners.get(event) ?? []), handler])
        return handler
      }
      if (!holding) return register()
      return new Promise((resolve) => waiting.push(() => resolve(register())))
    }
    if (cmd === 'plugin:event|unlisten') {
      const event = args['event'] as string
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((id) => id !== args['eventId']),
      )
      return null
    }
    invoked.push(cmd)
    return answer(cmd, args)
  })
  return {
    invoked,
    hold: () => void (holding = true),
    release: () => {
      holding = false
      for (const register of waiting.splice(0)) register()
    },
    listening: (event: string) => listeners.get(event)?.length ?? 0,
    /** Listeners asked for, registered or still held. */
    asked: (event: string) => asked.get(event) ?? 0,
    emit: (event: string, payload?: unknown) => {
      const internals = (
        window as unknown as Record<string, { runCallback: (id: number, data: unknown) => void }>
      )['__TAURI_INTERNALS__']!
      for (const id of listeners.get(event) ?? []) internals.runCallback(id, { event, id, payload })
    },
    clear: clearMocks,
  }
}
