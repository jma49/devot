// Swaps the CSS gradient of a gradient theme for a dithered painting of it (backdropPaint.ts) once
// the window settles. The tokens' gradient shows at once whenever the theme, appearance, strength or
// window size changes, so nothing ever shows a painting of another size or colour; the painting
// replaces it when it is ready.
import type { Paint } from './backdropPaint'

export interface BackdropJob {
  key: string
  paint: Paint
  /** In device pixels: painted at the screen's own resolution, so no scaling softens the dither into blotches. */
  width: number
  height: number
  /** Device pixels per CSS pixel. */
  density: number
}

export interface PainterHost {
  /** The painting the window should show now, or none for the tokens' own `--backdrop`. */
  wanted(): BackdropJob | null
  /** Paints a job off the main thread; resolves to an image URL ready to draw, or null. */
  paint(job: BackdropJob): { done: Promise<string | null>; cancel(): void }
  show(painting: { url: string; density: number } | null): void
  release(url: string): void
  setTimer(run: () => void, ms: number): number
  clearTimer(id: number): void
}

type State =
  | { kind: 'tokens' }
  | { kind: 'waiting'; key: string; timer: number }
  | { kind: 'painting'; key: string; cancel: () => void }
  | { kind: 'shown'; key: string; url: string }

/** How long the window must stay unchanged before it is painted: a slider drag or a resize settles first. */
export const SETTLE_MS = 150

export function createBackdropPainter(host: PainterHost): {
  update(): void
  stop(): void
} {
  let state: State = { kind: 'tokens' }

  const leave = () => {
    if (state.kind === 'waiting') host.clearTimer(state.timer)
    if (state.kind === 'painting') state.cancel()
    if (state.kind === 'shown') {
      host.show(null)
      host.release(state.url)
    }
    state = { kind: 'tokens' }
  }

  const start = (job: BackdropJob) => {
    const { done, cancel } = host.paint(job)
    state = { kind: 'painting', key: job.key, cancel }
    const finish = (url: string | null) => {
      if (state.kind !== 'painting' || state.key !== job.key) {
        if (url) host.release(url)
        return
      }
      if (!url) {
        state = { kind: 'tokens' }
        return
      }
      host.show({ url, density: job.density })
      state = { kind: 'shown', key: job.key, url }
    }
    done.then(finish, () => finish(null))
  }

  const update = () => {
    const job = host.wanted()
    if (job && state.kind !== 'tokens' && state.key === job.key) return
    leave()
    if (!job) return
    const timer = host.setTimer(() => {
      if (state.kind === 'waiting' && state.key === job.key) {
        const now = host.wanted()
        if (now?.key === job.key) start(now)
        else update()
      }
    }, SETTLE_MS)
    state = { kind: 'waiting', key: job.key, timer }
  }

  return { update, stop: leave }
}
