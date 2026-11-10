import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = 'src-tauri/src'

function rustFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return rustFiles(path)
    return entry.name.endsWith('.rs') ? [path] : []
  })
}

/** The builder chain from each `WebviewWindowBuilder::new(` up to `.build()`; `from_config` windows take the setting from tauri.conf.json. */
function builderChains(source: string): string[] {
  return [...source.matchAll(/WebviewWindowBuilder::new\(/g)].map((m) => {
    const end = source.indexOf('.build()', m.index)
    return source.slice(m.index, end === -1 ? undefined : end)
  })
}

// Issue #884: with Tauri's handler on, the Mac webview answers every drag itself and the page gets no dragover or drop.
describe("Tauri's drag and drop handler", () => {
  it('is off for the windows in tauri.conf.json', () => {
    const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
      app: { windows: { label: string; dragDropEnabled?: boolean }[] }
    }
    expect(config.app.windows.length).toBeGreaterThan(0)
    for (const window of config.app.windows)
      expect(window.dragDropEnabled, window.label).toBe(false)
  })

  it('is off for every window built in Rust', () => {
    const chains = rustFiles(SRC).flatMap((file) =>
      builderChains(readFileSync(file, 'utf8')).map((chain) => ({
        file,
        chain,
      })),
    )
    expect(chains.length).toBeGreaterThan(0)
    const missing = chains
      .filter(({ chain }) => !chain.includes('.disable_drag_drop_handler()'))
      .map(({ file }) => file)
    expect(missing).toEqual([])
  })
})
