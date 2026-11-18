import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = 'src-tauri/src'

// Windows that show note content (untrusted: imported, synced, AI-written) need WebRTC and
// resource hints off; the others load only the app's own pages.
const CONTENT_WINDOWS = ['main_windows.rs', 'note_window.rs']
const APP_UI_WINDOWS = ['cli_export.rs', 'menu_bar.rs', 'settings.rs']

function rustFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return rustFiles(path)
    return entry.name.endsWith('.rs') ? [path] : []
  })
}

function relative(path: string): string {
  return path.slice(SRC.length + 1)
}

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  expect(start).toBeGreaterThan(-1)
  const next = source.indexOf('\npub fn ', start + signature.length)
  return source.slice(start, next === -1 ? undefined : next)
}

describe('content window hardening', () => {
  it('knows every file that builds a web view window', () => {
    const builders = rustFiles(SRC)
      .filter((file) =>
        /WebviewWindowBuilder::(new|from_config)\(/.test(readFileSync(file, 'utf8')),
      )
      .map(relative)
      .sort()
    expect(builders).toEqual([...CONTENT_WINDOWS, ...APP_UI_WINDOWS].sort())
  })

  it('gives every window that shows note content the shared entry point', () => {
    const missing = CONTENT_WINDOWS.filter((file) => {
      const source = readFileSync(join(SRC, file), 'utf8')
      return !/crate::native::(content|main)_window_built\(&window\)/.test(source)
    })
    expect(missing).toEqual([])
  })

  it('turns WebRTC and resource hints off in the shared entry point, and main windows use it', () => {
    const source = readFileSync(join(SRC, 'native/mod.rs'), 'utf8')
    const content = functionBody(source, 'pub fn content_window_built(')
    expect(content).toContain('macos::turn_off_peer_connections(window)')
    expect(content).toContain('macos::turn_off_resource_hints(window)')
    expect(functionBody(source, 'pub fn main_window_built(')).toContain(
      'content_window_built(window)',
    )
  })
})
