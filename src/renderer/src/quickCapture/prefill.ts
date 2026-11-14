// Text a capture link brings (`devot://capture?…`, src-tauri/src/capture_link.rs): Rust holds it
// and tells this window, which takes it and adds it to what it holds, so nothing typed is lost and
// nothing is saved until the owner saves.
import { useEffect, useInsertionEffect, useRef } from 'react'
import { invoke } from '../ipc'
import { keepListening, listenHere } from '../windowEvents'

export interface Prefill {
  readonly title: string
  readonly body: string
}

interface Fields {
  readonly title: string
  readonly body: string
}

const PREFILL = 'devot:quick-capture-prefill'
const TAURI_EVENT = 'devot://quick-capture-prefill'

const isPrefill = (value: unknown): value is Prefill =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Prefill).title === 'string' &&
  typeof (value as Prefill).body === 'string'

export function readPrefills(value: unknown): Prefill[] {
  if (!Array.isArray(value)) return []
  const prefills = value.filter(isPrefill).map(({ title, body }) => ({ title, body }))
  if (prefills.length !== value.length) console.warn('W_CAPTURE_LINK_INVALID')
  return prefills
}

const filled = (text: string) => text.trim() !== ''

/**
 * What the window holds once a capture link's text is added: an empty title takes the link's, and
 * the link's text (its title first when the window has another) goes after the body.
 */
export function withPrefill(current: Fields, prefill: Prefill): Fields {
  const keepsTitle = filled(current.title)
  const title = keepsTitle ? current.title : prefill.title
  const titleLine = keepsTitle && filled(prefill.title) && prefill.title !== current.title
  const added = [titleLine ? prefill.title : '', prefill.body].filter(filled).join('\n')
  if (!filled(added)) return { title, body: current.body }
  const body = filled(current.body) ? `${current.body.trimEnd()}\n\n${added}` : added
  return { title, body }
}

export async function takePrefills(): Promise<Prefill[]> {
  try {
    return readPrefills(await invoke<unknown>('quick_capture_prefill_take'))
  } catch {
    console.warn('W_CAPTURE_LINK_TAKE_FAILED')
    return []
  }
}

/**
 * Takes what links brought: what waits once the window listens, then whatever comes. While
 * `paused` (a save on its way, its fields read-only) it takes nothing, and takes what came once
 * the pause ends; a save that succeeds takes it itself before the window closes.
 */
export function usePrefills(apply: (prefills: Prefill[]) => void, paused: boolean): void {
  const latest = useRef(apply)
  const pausedRef = useRef(paused)
  const missed = useRef(false)
  useInsertionEffect(() => {
    latest.current = apply
    pausedRef.current = paused
  })

  const takeRef = useRef<() => void>(undefined)
  useEffect(() => {
    let stopped = false
    const take = () => {
      if (pausedRef.current) {
        missed.current = true
        return
      }
      void takePrefills().then((prefills) => {
        if (!stopped && prefills.length > 0) latest.current(prefills)
      })
    }
    takeRef.current = take
    window.addEventListener(PREFILL, take)
    const listening = keepListening(
      DEVOT_UI_TEST
        ? Promise.resolve([])
        : listenHere<unknown>(TAURI_EVENT, () => window.dispatchEvent(new CustomEvent(PREFILL))),
    )
    // Listening first, then asking for what waits: no link is lost between.
    listening.ready
      .catch(() => console.warn('W_CAPTURE_LINK_LISTEN_FAILED'))
      .then(() => {
        if (!listening.stopped()) take()
      })
    return () => {
      stopped = true
      takeRef.current = undefined
      listening.stop()
      window.removeEventListener(PREFILL, take)
    }
  }, [])

  useEffect(() => {
    if (paused || !missed.current) return
    missed.current = false
    takeRef.current?.()
  }, [paused])
}
