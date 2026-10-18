import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { COMMANDS } from '../../src/renderer/src/commands/registry'

const rust = readFileSync('src-tauri/src/deep_link.rs', 'utf8')

/** The window's list, as written in deepLink.ts (read as text: it is UI code). */
const URL_COMMANDS = [
  ...(
    readFileSync('src/renderer/src/deepLink.ts', 'utf8').match(
      /export const URL_COMMANDS = \[([^\]]*)\]/,
    )?.[1] ?? ''
  ).matchAll(/'([^']+)'/g),
].map((m) => m[1] ?? '')

/** A `&str` constant of deep_link.rs. */
const rustConst = (name: string) => rust.match(new RegExp(`const ${name}: &str = "([^"]*)"`))?.[1]

/** The schemes a Tauri config registers with macOS. */
function schemes(file: string): unknown {
  const config = JSON.parse(readFileSync(file, 'utf8')) as {
    plugins?: { 'deep-link'?: { desktop?: { schemes?: unknown } } }
  }
  return config.plugins?.['deep-link']?.desktop?.schemes
}

describe('the devot:// URL scheme', () => {
  it('lets URLs run the same commands in Rust and in the window', () => {
    const list = rust.match(/const URL_COMMANDS: &\[&str\] = &\[([^\]]*)\]/)?.[1] ?? ''
    const fromRust = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(fromRust).toHaveLength(11)
    expect(fromRust).toEqual([...URL_COMMANDS])
  })

  it('lets URLs run only registry commands that show something or make an empty note', () => {
    const ids = new Set<string>(COMMANDS.map((c) => c.id))
    expect(URL_COMMANDS.filter((id) => !ids.has(id))).toEqual([])
    const harmful =
      /trash\.|delete|purge|remove|import|export|copy|move|duplicate|restore|empty|clipboard|paste|cut|rename|tag|status|pin|format|insert|table/i
    expect(URL_COMMANDS.filter((id) => id !== 'view.trash' && harmful.test(id))).toEqual([])
  })

  it('registers devot:// for release builds and devot-dev:// for debug builds', () => {
    expect(rustConst('RELEASE_SCHEME')).toBe('devot')
    expect(rustConst('DEBUG_SCHEME')).toBe('devot-dev')
    expect(schemes('src-tauri/tauri.conf.json')).toEqual(['devot'])
    expect(schemes('src-tauri/tauri.debug.conf.json')).toEqual(['devot-dev'])
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    ).scripts
    expect(scripts['build:debug']).toBe(
      'tauri build --debug --config src-tauri/tauri.debug.conf.json',
    )
  })
})
