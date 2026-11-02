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
  tint: string | null
}

export interface SidebarBox {
  left: number
  top: number
  width: number
  height: number
}

const RADIUS = Number.parseFloat(sizes['radius.sidebar'])

export function sidebarSurround(
  frame: GlassFrame,
  viewport: { width: number; height: number },
): string {
  const { x, y, width, height, radius: r } = frame
  const right = x + width
  const bottom = y + height
  // The continuous window sheet leaves a rounded hole for native glass.
  const outer = `M0 0H${viewport.width}V${viewport.height}H0Z`
  const hole =
    `M${x + r} ${y}H${right - r}A${r} ${r} 0 0 1 ${right} ${y + r}` +
    `V${bottom - r}A${r} ${r} 0 0 1 ${right - r} ${bottom}` +
    `H${x + r}A${r} ${r} 0 0 1 ${x} ${bottom - r}` +
    `V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`
  return `path(evenodd, '${outer}${hole}')`
}

const hexPart = (value: number) => Math.round(value).toString(16).padStart(2, '0')

/** The hex colour the system's glass takes for a tint token; null for a transparent or unreadable one. */
export function glassTint(token: string): string | null {
  const parts = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(token.trim())
  if (!parts) return null
  const alpha = parts[4] === undefined ? 1 : Number(parts[4])
  if (alpha === 0) return null
  const channels = [Number(parts[1]), Number(parts[2]), Number(parts[3]), alpha * 255]
  return `#${channels.map(hexPart).join('')}`
}

export function glassFrame(
  box: SidebarBox | undefined,
  shown: { material: boolean; visible: boolean; tint?: string | null },
): GlassFrame | null {
  if (!box || !shown.material || !shown.visible) return null
  const width = Math.round(box.width)
  const height = Math.round(box.height)
  if (width < 1 || height < 1) return null
  return {
    x: Math.round(box.left),
    y: Math.round(box.top),
    width,
    height,
    radius: RADIUS,
    tint: shown.tint ?? null,
  }
}

export function sameFrame(a: GlassFrame | null | undefined, b: GlassFrame | null): boolean {
  if (a === undefined) return false
  if (a === null || b === null) return a === b
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.radius === b.radius &&
    a.tint === b.tint
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
  const sidebar = doc.querySelector<HTMLElement>('.window > .sidebar, .settings > .settings-nav')
  const win = sidebar?.parentElement
  const visible =
    !!sidebar &&
    !win?.hasAttribute('data-sidebar-hidden') &&
    !win?.hasAttribute('data-focus') &&
    getComputedStyle(sidebar).visibility !== 'hidden'
  return glassFrame(sidebar?.getBoundingClientRect(), {
    material: root.dataset['sidebarMaterial'] === 'on',
    visible,
    tint: glassTint(getComputedStyle(root).getPropertyValue('--color-surface-glass-tint')),
  })
}

function nativeFrame(doc: Document): GlassFrame | null {
  return doc.defaultView?.matchMedia('(prefers-reduced-transparency: reduce)').matches ||
    doc.defaultView?.matchMedia('(prefers-contrast: more)').matches
    ? null
    : measure(doc)
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
      const surroundFrame = measure(doc)
      if (surroundFrame) {
        root.style.setProperty(
          '--sidebar-surround-clip',
          sidebarSurround(surroundFrame, {
            width: root.clientWidth,
            height: root.clientHeight,
          }),
        )
      } else {
        root.style.removeProperty('--sidebar-surround-clip')
      }
      let frame = nativeFrame(doc)
      while (!sameFrame(sent, frame)) {
        sent = frame
        let native = false
        try {
          if (!DEVOT_UI_TEST) native = await invoke<boolean>('sidebar_glass', { frame })
        } catch {
          console.warn('W_SIDEBAR_GLASS_FAILED')
        }
        showNativeGlass(root, native && frame !== null)
        frame = nativeFrame(doc)
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
    attributeFilter: [
      'data-sidebar-material',
      'data-sidebar-hidden',
      'data-focus',
      'data-appearance',
      'data-theme',
    ],
    childList: true,
    subtree: true,
  })
  // Panes slide by transforms (paneMotion.ts), which no observer reports: measure where they settle.
  doc.addEventListener('transitionend', schedule)
  doc.addEventListener('animationend', schedule)
  for (const query of [
    '(prefers-reduced-transparency: reduce)',
    '(prefers-contrast: more)',
    '(prefers-color-scheme: dark)',
  ]) {
    doc.defaultView?.matchMedia(query).addEventListener('change', schedule)
  }
  schedule()
}
