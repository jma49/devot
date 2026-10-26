import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// Desktop builds are the only ones CI compiles, so a desktop-only command listed without its own
// `#[cfg(desktop)]` would break only the iOS build.
const LIB = readFileSync('src-tauri/src/lib.rs', 'utf8')

it('gates every command of a desktop-only module with its own cfg(desktop)', () => {
  const desktopModules = [...LIB.matchAll(/#\[cfg\(desktop\)\]\s*mod (\w+);/g)].map((m) => m[1])
  expect(desktopModules).toContain('menu_bar')
  const handler = /generate_handler!\[([\s\S]*?)\]\)/.exec(LIB)?.[1]
  expect(handler).toBeDefined()
  const lines = (handler ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const ungated = lines.filter(
    (line, i) =>
      desktopModules.some((name) => line.startsWith(`${name}::`)) &&
      lines[i - 1] !== '#[cfg(desktop)]',
  )
  expect(ungated).toEqual([])
})
