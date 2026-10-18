// Links other apps open: `devot://note/<id>` opens a note and
// `devot://command/<id>` runs one of `URL_COMMANDS` (`devot-dev://` in a
// debug build). Rust checks every URL and sends the main window only what it
// asks for, as a link (`src-tauri/src/deep_link.rs`); the window reads it
// again here and takes nothing else. Links wait while a sheet is up and run,
// in order, once none is.
import { useEffect, useRef } from 'react'
import { sheetOpen } from './commands/dispatch'
import type { CommandId } from './commands/registry'
import { invoke } from './ipc'

/**
 * The commands a URL may run: each one only shows something or makes an
 * empty note. Rust keeps the same list (a test compares them).
 */
export const URL_COMMANDS = [
  'note.new',
  'palette.open',
  'view.allNotes',
  'view.trash',
  'view.focus',
  'view.togglePreview',
  'view.split',
  'view.edit',
  'view.preview',
  'app.backups',
  'app.checkForUpdates',
] as const satisfies readonly CommandId[]

export type UrlCommand = (typeof URL_COMMANDS)[number]

export type DeepLink =
  | { readonly kind: 'note'; readonly id: string }
  | { readonly kind: 'command'; readonly id: UrlCommand }

/** A note ID as Rust accepts one: a canonical, lowercase UUIDv7. */
const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const isUrlCommand = (id: unknown): id is UrlCommand =>
  typeof id === 'string' && (URL_COMMANDS as readonly string[]).includes(id)

/** A link as Rust sends it, or undefined for anything else. */
export function readDeepLink(value: unknown): DeepLink | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { kind, id } = value as { kind?: unknown; id?: unknown }
  if (kind === 'note' && typeof id === 'string' && NOTE_ID.test(id)) return { kind, id }
  if (kind === 'command' && isUrlCommand(id)) return { kind, id }
  return undefined
}

/** Where a linked note is, and so what opening it takes. */
export type NoteTarget =
  /** In the list shown: open it. */
  | { readonly kind: 'listed' }
  /** Live, outside the list shown: show this library first. */
  | { readonly kind: 'library'; readonly library: 'all' | 'templates' }
  /** In the Trash: open it there. */
  | { readonly kind: 'trash' }
  /** No such note. */
  | { readonly kind: 'missing' }

interface Known {
  readonly listed: ReadonlySet<string>
  readonly notes: readonly { readonly id: string }[]
  readonly templates: readonly { readonly id: string }[]
  readonly trash: readonly { readonly id: string }[]
}

/** Where the note `id` is. */
export function noteTarget(id: string, known: Known): NoteTarget {
  const has = (list: readonly { readonly id: string }[]) => list.some((n) => n.id === id)
  if (has(known.trash)) return { kind: 'trash' }
  if (known.listed.has(id)) return { kind: 'listed' }
  if (has(known.templates)) return { kind: 'library', library: 'templates' }
  if (has(known.notes)) return { kind: 'library', library: 'all' }
  return { kind: 'missing' }
}

/**
 * Runs links in the order they came, holding them while `blocked()` (a sheet
 * is up). `watch` calls back on each change that may end that, until the
 * function it returns is called; it runs only while links wait.
 */
export class LinkQueue {
  private readonly waiting: DeepLink[] = []
  private unwatch: (() => void) | undefined
  private stopped = false

  constructor(
    private readonly run: (link: DeepLink) => void,
    private readonly blocked: () => boolean,
    private readonly watch: (changed: () => void) => () => void,
  ) {}

  push(link: DeepLink): void {
    if (this.stopped) return
    this.waiting.push(link)
    this.flush()
  }

  /** Runs what waits, unless blocked; watches for the end of the block otherwise. */
  flush(): void {
    while (!this.stopped && this.waiting.length > 0 && !this.blocked()) {
      const link = this.waiting.shift()
      if (link) this.run(link)
    }
    if (this.waiting.length > 0 && !this.stopped) {
      this.unwatch ??= this.watch(() => this.flush())
    } else {
      this.unwatch?.()
      this.unwatch = undefined
    }
  }

  stop(): void {
    this.stopped = true
    this.waiting.length = 0
    this.unwatch?.()
    this.unwatch = undefined
  }
}

/** Calls back when a sheet (a `<dialog>`) may have closed. */
function watchSheets(changed: () => void): () => void {
  const observer = new MutationObserver(changed)
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['open'],
  })
  return () => observer.disconnect()
}

/** The page event a link arrives as (Rust's `devot://open-url`, re-sent; tests send it too). */
export const OPEN_URL = 'devot:open-url'
const TAURI_EVENT = 'devot://open-url'

/**
 * Runs `handle` for each link, from the moment `ready` is true (the window
 * has restored its view): first the links that came before (Rust held them;
 * `deep_link_take`), then each one as it comes.
 */
export function useDeepLinks(ready: boolean, handle: (link: DeepLink) => void): void {
  const latest = useRef(handle)
  useEffect(() => {
    latest.current = handle
  })
  useEffect(() => {
    if (!ready) return
    const queue = new LinkQueue((link) => latest.current(link), sheetOpen, watchSheets)
    const take = (value: unknown) => {
      const link = readDeepLink(value)
      if (link) queue.push(link)
      else console.warn('W_DEEP_LINK_INVALID')
    }
    const onEvent = (e: Event) => take(e instanceof CustomEvent ? e.detail : undefined)
    window.addEventListener(OPEN_URL, onEvent)
    let stopped = false
    let unlisten: (() => void) | undefined
    // Listening first, then asking for what waits: no link is lost between.
    const listening = DEVOT_UI_TEST
      ? Promise.resolve()
      : import('@tauri-apps/api/event').then(async ({ listen }) => {
          const stop = await listen<unknown>(TAURI_EVENT, (event) =>
            window.dispatchEvent(new CustomEvent(OPEN_URL, { detail: event.payload })),
          )
          if (stopped) stop()
          else unlisten = stop
        })
    listening
      .catch(() => console.warn('W_DEEP_LINK_LISTEN_FAILED'))
      .then(() => (stopped ? [] : invoke<unknown>('deep_link_take')))
      .then(
        (held) => {
          if (!stopped && Array.isArray(held)) held.forEach(take)
        },
        () => console.warn('W_DEEP_LINK_TAKE_FAILED'),
      )
    return () => {
      stopped = true
      window.removeEventListener(OPEN_URL, onEvent)
      unlisten?.()
      queue.stop()
    }
  }, [ready])
}
