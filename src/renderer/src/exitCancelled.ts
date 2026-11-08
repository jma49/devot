// A held quit can be called off after some windows have already answered and stopped what they had
// running (the Markdown mirror, an import): Rust tells every window which quit, and each starts its
// own again.
import { quitRound } from './saveGuards'

export const EXIT_CANCELLED_EVENT = 'devot://exit-cancelled'

/** Resolves, with the way to stop, once the page hears a called-off quit; it never rejects. */
export function listenExitCancelled(restart: (round: number) => void): Promise<() => void> {
  return import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<unknown>(EXIT_CANCELLED_EVENT, ({ payload }) => {
        const round = quitRound(payload)
        if (round === undefined) console.warn('W_EXIT_ROUND_MISSING')
        else restart(round)
      }),
    )
    .catch(() => {
      console.warn('W_EXIT_CANCELLED_LISTEN_FAILED')
      return () => {}
    })
}
