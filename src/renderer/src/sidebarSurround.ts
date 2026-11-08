// The floating sidebar's cutout in the Glass interface's sheet (app.css). The note list and the
// editor share one sheet; the sidebar floats inset from it, so the sheet leaves a rounded hole where
// the sidebar is and the sidebar paints its own glass surface there. The page measures the sidebar
// and tells CSS where the hole is, following it as it moves, resizes, hides and shows.
import { onlyNoteContent } from './noteContent'
import { sizes } from './theme/tokens'

export interface SidebarBox {
  left: number
  top: number
  width: number
  height: number
}

const RADIUS = Number.parseFloat(sizes['radius.sidebar'])
const CLIP = '--sidebar-surround-clip'

export function sidebarSurround(
  frame: SidebarBox,
  viewport: { width: number; height: number },
): string {
  const { left: x, top: y, width, height } = frame
  const r = RADIUS
  const right = x + width
  const bottom = y + height
  // The continuous window sheet leaves a rounded hole for the sidebar.
  const outer = `M0 0H${viewport.width}V${viewport.height}H0Z`
  const hole =
    `M${x + r} ${y}H${right - r}A${r} ${r} 0 0 1 ${right} ${y + r}` +
    `V${bottom - r}A${r} ${r} 0 0 1 ${right - r} ${bottom}` +
    `H${x + r}A${r} ${r} 0 0 1 ${x} ${bottom - r}` +
    `V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`
  return `path(evenodd, '${outer}${hole}')`
}

export function surroundFrame(
  box: SidebarBox | undefined,
  shown: { visible: boolean },
): SidebarBox | null {
  if (!box || !shown.visible) return null
  const width = Math.round(box.width)
  const height = Math.round(box.height)
  if (width < 1 || height < 1) return null
  return {
    left: Math.round(box.left),
    top: Math.round(box.top),
    width,
    height,
  }
}

function measure(doc: Document): { sheet: HTMLElement | null; frame: SidebarBox | null } {
  const sidebar = doc.querySelector<HTMLElement>('.window > .sidebar, .settings > .settings-nav')
  const sheet = sidebar?.parentElement ?? null
  const visible =
    !!sidebar &&
    !sheet?.hasAttribute('data-sidebar-hidden') &&
    !sheet?.hasAttribute('data-focus') &&
    getComputedStyle(sidebar).visibility !== 'hidden'
  return { sheet, frame: surroundFrame(sidebar?.getBoundingClientRect(), { visible }) }
}

let started = false

/** Keeps the sheet's cutout where the sidebar is, as it moves, resizes, hides and shows. Once per page. */
export function startSidebarSurround(doc: Document = document): void {
  if (started) return
  started = true
  const root = doc.documentElement
  const media = (query: string) => doc.defaultView?.matchMedia(query)
  const plain = [media('(prefers-reduced-transparency: reduce)'), media('(prefers-contrast: more)')]
  let queued = 0
  let sent: { sheet: HTMLElement; clip: string } | null = null

  // On the sheet, whose children reset it (app.css), not the root: the cutout changes with every
  // resize, and inherited from the root it restyled every block of the note (issue 786).
  const send = () => {
    const { sheet, frame } = plain.some((query) => query?.matches)
      ? { sheet: null, frame: null }
      : measure(doc)
    const clip = frame
      ? sidebarSurround(frame, { width: root.clientWidth, height: root.clientHeight })
      : null
    const next = sheet && clip ? { sheet, clip } : null
    if (next?.sheet === sent?.sheet && next?.clip === sent?.clip) return
    if (sent && sent.sheet !== next?.sheet) sent.sheet.style.removeProperty(CLIP)
    if (next) next.sheet.style.setProperty(CLIP, next.clip)
    sent = next
  }

  const schedule = () => {
    if (queued) return
    queued = requestAnimationFrame(() => {
      queued = 0
      send()
    })
  }

  const resized = new ResizeObserver(schedule)
  resized.observe(root)
  let watched: Element | null = null
  const changed = new MutationObserver((records) => {
    // A render of the note moves no sidebar.
    if (onlyNoteContent(records)) return
    const sidebar = doc.querySelector('.window > .sidebar, .settings > .settings-nav')
    if (sidebar !== watched) {
      if (watched) resized.unobserve(watched)
      if (sidebar) resized.observe(sidebar)
      watched = sidebar
    }
    schedule()
  })
  changed.observe(root, {
    attributes: true,
    attributeFilter: ['data-sidebar-hidden', 'data-focus', 'data-appearance', 'data-theme'],
    childList: true,
    subtree: true,
  })
  // Panes slide by transforms (paneMotion.ts), which no observer reports: measure where they settle.
  doc.addEventListener('transitionend', schedule)
  doc.addEventListener('animationend', schedule)
  for (const query of [...plain, media('(prefers-color-scheme: dark)')]) {
    query?.addEventListener('change', schedule)
  }
  schedule()
}
