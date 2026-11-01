// The floating sidebar's glass in the Glass interface. On macOS 26 Rust draws the system's glass
// under the web view where the sidebar is (`sidebar_glass`); the page tells it where, and leaves
// the sidebar's own tint off once Rust answers that the glass is there (`data-native-glass`).
// Anywhere else Rust answers false and the CSS tint stands in (app.css, Glass interface).
import { invoke } from './ipc'
import { sizes } from './theme/tokens'

export interface GlassFrame {
  x: number
  y: number
  width: number
  height: number
  radius: number
}

export interface SidebarBox {
  left: number
  top: number
  width: number
  height: number
}

const RADIUS = Number.parseFloat(sizes['radius.sidebar'])

export function glassFrame(
  box: SidebarBox | undefined,
  shown: { material: boolean; visible: boolean },
): GlassFrame | null {
  if (!box || !shown.material || !shown.visible) return null
  const width = Math.round(box.width)
  const height = Math.round(box.height)
  if (width < 1 || height < 1) return null
  return { x: Math.round(box.left), y: Math.round(box.top), width, height, radius: RADIUS }
}

export function sameFrame(a: GlassFrame | null | undefined, b: GlassFrame | null): boolean {
  if (a === undefined) return false
  if (a === null || b === null) return a === b
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.radius === b.radius
  )
}

export function showNativeGlass(
  root: { dataset: Record<string, string | undefined> },
  native: boolean,
): void {
  if (native) root.dataset['nativeGlass'] = 'on'
  else delete root.dataset['nativeGlass']
}

function measure(doc: Document): GlassFrame | null {
  const root = doc.documentElement
  const sidebar = doc.querySelector<HTMLElement>('.window > .sidebar')
  const win = sidebar?.parentElement
  const visible =
    !!sidebar &&
    !win?.hasAttribute('data-sidebar-hidden') &&
    !win?.hasAttribute('data-focus') &&
    getComputedStyle(sidebar).visibility !== 'hidden'
  return glassFrame(sidebar?.getBoundingClientRect(), {
    material: root.dataset['sidebarMaterial'] === 'on',
    visible,
  })
}

let started = false

/** Keeps the system's glass under the sidebar as it moves, resizes, hides and shows. Once per page. */
export function startSidebarGlass(doc: Document = document): void {
  if (started) return
  started = true
  const root = doc.documentElement
  let sent: GlassFrame | null | undefined
  let sending = false
  let queued = 0

  const send = async () => {
    if (sending) return
    sending = true
    try {
      let frame = measure(doc)
      while (!sameFrame(sent, frame)) {
        sent = frame
        let native = false
        try {
          native = await invoke<boolean>('sidebar_glass', { frame })
        } catch {
          console.warn('W_SIDEBAR_GLASS_FAILED')
        }
        showNativeGlass(root, native && frame !== null)
        frame = measure(doc)
      }
    } finally {
      sending = false
    }
  }

  const schedule = () => {
    if (queued) return
    queued = requestAnimationFrame(() => {
      queued = 0
      void send()
    })
  }

  const resized = new ResizeObserver(schedule)
  resized.observe(root)
  let watched: Element | null = null
  const changed = new MutationObserver(() => {
    const sidebar = doc.querySelector('.window > .sidebar')
    if (sidebar !== watched) {
      if (watched) resized.unobserve(watched)
      if (sidebar) resized.observe(sidebar)
      watched = sidebar
    }
    schedule()
  })
  changed.observe(root, {
    attributes: true,
    attributeFilter: ['data-sidebar-material', 'data-sidebar-hidden', 'data-focus'],
    childList: true,
    subtree: true,
  })
  // Panes slide by transforms (paneMotion.ts), which no observer reports: measure where they settle.
  doc.addEventListener('transitionend', schedule)
  doc.addEventListener('animationend', schedule)
  schedule()
}
