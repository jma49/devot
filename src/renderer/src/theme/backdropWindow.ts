// Runs the backdrop painter (backdropPainter.ts) in this window: a gradient theme's `--backdrop`
// becomes a dithered painting of the window's size, set on the root over the tokens' gradient.
import { editorSettings, subscribeEditorSettings } from '../editorSettings'
import { mixTowardsSolid, type Paint } from './backdropPaint'
import { createBackdropPainter, type BackdropJob, type PainterHost } from './backdropPainter'
import { shownAppearance, subscribeAppearance } from './appearance'
import { backdrops } from './tokens'

/** Larger than any screen: a box past it keeps the tokens' gradient rather than a huge painting. */
const MAX_SIDE = 8192

function paintJob(root: HTMLElement): BackdropJob | null {
  const theme = root.dataset['theme'] ?? ''
  const own = (backdrops as Record<string, { light: Paint; dark: Paint } | undefined>)[theme]
  const strength = editorSettings().gradientStrength
  const width = root.clientWidth
  const height = root.clientHeight
  if (!own || strength <= 0 || width < 1 || height < 1) return null
  if (width > MAX_SIDE || height > MAX_SIDE) return null
  const appearance = shownAppearance()
  return {
    key: `${theme}/${appearance}/${strength}/${width}x${height}`,
    paint: mixTowardsSolid(own[appearance], strength),
    width,
    height,
  }
}

function paintInWorker(job: BackdropJob): { done: Promise<string | null>; cancel(): void } {
  const worker = new Worker(new URL('./backdrop.worker.ts', import.meta.url), { type: 'module' })
  let cancelled = false
  const done = new Promise<string | null>((resolve) => {
    worker.onmessage = ({ data }: MessageEvent<unknown>) => {
      worker.terminate()
      if (cancelled || !(data instanceof Blob)) return resolve(null)
      const url = URL.createObjectURL(data)
      // Decoded before it is shown, so the swap never draws a frame without a backdrop.
      const image = new Image()
      image.src = url
      image.decode().then(
        () => resolve(url),
        () => {
          URL.revokeObjectURL(url)
          resolve(null)
        },
      )
    }
    worker.onerror = () => {
      worker.terminate()
      resolve(null)
    }
    worker.postMessage({ paint: job.paint, width: job.width, height: job.height })
  })
  return {
    done,
    cancel: () => {
      cancelled = true
      worker.terminate()
    },
  }
}

let started = false

/** Once per page, after `startAppearance`. */
export function startBackdropPainter(root: HTMLElement = document.documentElement): void {
  if (started) return
  started = true
  const host: PainterHost = {
    wanted: () => paintJob(root),
    paint: paintInWorker,
    show: (url) =>
      url
        ? root.style.setProperty('--backdrop', `url("${url}")`)
        : root.style.removeProperty('--backdrop'),
    release: (url) => URL.revokeObjectURL(url),
    setTimer: (run, ms) => window.setTimeout(run, ms),
    clearTimer: (id) => window.clearTimeout(id),
  }
  const painter = createBackdropPainter(host)
  subscribeEditorSettings(painter.update)
  subscribeAppearance(painter.update)
  new ResizeObserver(painter.update).observe(root)
  painter.update()
}
