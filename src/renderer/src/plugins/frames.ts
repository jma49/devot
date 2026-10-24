// A plugin's frame in the main window (ADR 0005): `<iframe sandbox="allow-scripts">` on Rust's `devot-plugin://` scheme, an opaque
// origin. Its page (Devot's container, src-tauri/plugin-frame/) frames the plugin's own page; the port handed in here goes on to it.
import type { InstalledPlugin } from '../../../core/plugins'
import type { Connection } from './host'

/** The UI tests serve the same pages under the test server (tests/ui/plugins.ts). */
export const pluginBase = (id: string) =>
  DEVOT_UI_TEST ? `${location.origin}/__devot-plugins/${id}/` : `devot-plugin://localhost/${id}/`

const LOAD_TIMEOUT_MS = 10_000

export function frameConnector(
  parent: { readonly current: HTMLElement | null },
  base: (id: string) => string = pluginBase,
): (plugin: InstalledPlugin) => Promise<Connection> {
  return (plugin) =>
    new Promise((resolve, reject) => {
      const into = parent.current
      if (!into) {
        reject(new Error('E_PLUGIN_UNAVAILABLE'))
        return
      }
      const frame = document.createElement('iframe')
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.setAttribute('allow', '')
      frame.referrerPolicy = 'no-referrer'
      frame.className = 'plugin-frame'
      frame.title = plugin.manifest.name
      frame.dataset['plugin'] = plugin.manifest.id
      frame.hidden = true
      const timer = setTimeout(() => {
        frame.remove()
        reject(new Error('E_PLUGIN_LOAD_TIMEOUT'))
      }, LOAD_TIMEOUT_MS)
      frame.addEventListener(
        'load',
        () => {
          clearTimeout(timer)
          const channel = new MessageChannel()
          frame.contentWindow?.postMessage({ devot: 1, kind: 'connect' }, '*', [channel.port2])
          resolve({
            port: channel.port1,
            close: () => {
              channel.port1.close()
              frame.remove()
            },
          })
        },
        { once: true },
      )
      frame.src = base(plugin.manifest.id)
      into.append(frame)
    })
}

/** Shows one plugin's frame at `height` (through the CSSOM, which the policy allows) and hides the others. */
export function showFrame(parent: HTMLElement | null, plugin: string | null, height: number): void {
  for (const frame of parent?.querySelectorAll<HTMLIFrameElement>('iframe.plugin-frame') ?? []) {
    const shown = frame.dataset['plugin'] === plugin
    frame.hidden = !shown
    if (shown) frame.style.setProperty('height', `${height}px`)
  }
}
