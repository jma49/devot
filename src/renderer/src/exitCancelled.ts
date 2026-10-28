// A held quit can be called off after some windows have already answered and stopped what they had
// running (the Markdown mirror): Rust tells every window, and each starts its own again.
export const EXIT_CANCELLED_EVENT = 'devot://exit-cancelled'

/** Resolves, with the way to stop, once the page hears a called-off quit; it never rejects. */
export function listenExitCancelled(restart: () => void): Promise<() => void> {
  return import('@tauri-apps/api/event')
    .then(({ listen }) => listen(EXIT_CANCELLED_EVENT, restart))
    .catch(() => {
      console.warn('W_EXIT_CANCELLED_LISTEN_FAILED')
      return () => {}
    })
}
