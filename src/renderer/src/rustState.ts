// A state Rust keeps and announces to every window on change (the licence, sync, updates, the
// mirror, editor settings). The window listens before it reads, so a change Rust emits once the
// read is answered always reaches it; the UI tests' build announces with the page event alone.

export interface RustState {
  /** The Tauri event Rust emits with the new state. */
  event: string
  /** The page event the window, and the UI tests, hand that state on with. */
  pageEvent: string
  read: () => Promise<unknown>
  take: (value: unknown) => void
  /**
   * The state carries no revision to order it by: a read answered after an event may be older
   * than it, so the read's reply is dropped then.
   */
  unrevisioned?: boolean
  readFailed: string
  listenFailed: string
}

/** Settles once the first read is answered (or has failed); it never rejects. */
export function followRustState(state: RustState): Promise<void> {
  let heard = false
  window.addEventListener(state.pageEvent, (e) => {
    heard = true
    state.take((e as CustomEvent<unknown>).detail)
  })
  const listening = DEVOT_UI_TEST
    ? Promise.resolve()
    : import('@tauri-apps/api/event')
        .then(({ listen }) =>
          listen<unknown>(state.event, (e) =>
            window.dispatchEvent(new CustomEvent(state.pageEvent, { detail: e.payload })),
          ),
        )
        .then(
          () => {},
          () => console.warn(state.listenFailed),
        )
  return listening.then(state.read).then(
    (value) => {
      if (!(state.unrevisioned && heard)) state.take(value)
    },
    () => console.warn(state.readFailed),
  )
}
