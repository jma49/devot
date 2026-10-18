// The window material in the main window (Settings > Appearance). The
// setting is stored with the editor settings (still `sidebarMaterial`); this
// module decides what the window shows and keeps the page and Rust's window
// effect in an order that never lets the desktop show through a bare wash:
//
// - turned off, the page paints every region (and the root, behind every
//   pane) opaque first and, once that has been painted, asks Rust to drop
//   the effect;
// - turned on, it asks Rust to restore the effect first and turns the
//   regions translucent only once Rust has applied it.
//
// The root element carries `data-sidebar-material="on|off"`, which the CSS
// reads (app.css).
import { editorSettings, subscribeEditorSettings } from './editorSettings'
import { invoke } from './ipc'

export interface MaterialTarget {
  dataset: Record<string, string | undefined>
}

/** What the settings ask for; the page catches up with it. */
let wanted = true
let target: MaterialTarget | undefined

/** What the page shows. */
function show(material: boolean) {
  if (target) target.dataset['sidebarMaterial'] = material ? 'on' : 'off'
}

/** Resolves once the page has painted what it shows now. */
const painted = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )

const sync = () => invoke<boolean>('sidebar_material_sync')

async function follow() {
  const next = editorSettings().sidebarMaterial
  if (next === wanted) return
  wanted = next
  if (!next) {
    show(false)
    await painted()
  }
  let shown: boolean
  try {
    shown = await sync()
  } catch {
    // Off: the regions are opaque whatever the window does. On: they stay
    // opaque, which looks right over the effect as well as without it.
    console.warn('W_SIDEBAR_MATERIAL_SYNC_FAILED')
    return
  }
  // A later change may have turned it off again meanwhile, here or only in
  // Rust so far (Rust follows the stored settings and reports the material
  // the window shows; that change's event is still on its way).
  if (next && wanted && shown) show(true)
}

let started = false

/**
 * Shows the stored material (the window was built with it) and follows
 * changes made in any window. Once per page, after `startEditorSettings`.
 */
export function startSidebarMaterial(
  root: MaterialTarget = document.documentElement as unknown as MaterialTarget,
): void {
  if (started) return
  started = true
  target = root
  wanted = editorSettings().sidebarMaterial
  show(wanted)
  subscribeEditorSettings(() => void follow())
}
