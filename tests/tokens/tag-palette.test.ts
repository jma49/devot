import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BUILT_IN_THEMES } from '../../scripts/tokens/themes'
import { TAG_COLORS } from '../../src/core/storage'
import { en } from '../../src/renderer/src/i18n/en'

// The tag colour palette is a list of IDs shared by the core, Rust (which
// validates them) and the themes (which give each one a colour).
const read = (path: string) => readFileSync(path, 'utf8')
const THEME_IDS = ['system', ...BUILT_IN_THEMES.map((t) => t.id)]
const theme = (appearance: 'light' | 'dark', id = 'system') =>
  JSON.parse(read(`design/tokens/themes/${id}.${appearance}.tokens.json`)) as {
    color: { tag?: Record<string, unknown> }
  }

describe('tag colour palette', () => {
  it('is the same list in the core and in Rust', () => {
    const rust = /pub const TAG_COLORS: \[&str; \d+\] = \[([^\]]*)\]/.exec(
      read('src-tauri/src/storage/mod.rs'),
    )
    const ids = [...(rust?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(ids).toEqual([...TAG_COLORS])
  })

  it('has a theme token for every colour, light and dark, and nothing else', () => {
    for (const id of THEME_IDS) {
      for (const appearance of ['light', 'dark'] as const) {
        expect(Object.keys(theme(appearance, id).color.tag ?? {})).toEqual([...TAG_COLORS])
      }
    }
    const css = read('src/renderer/src/theme/tokens.css')
    // Per theme: the system's light and dark, then each appearance chosen in Settings.
    const counts = TAG_COLORS.map((id) => css.split(`--color-tag-${id}:`).length - 1)
    expect(counts).toEqual(TAG_COLORS.map(() => 4 * THEME_IDS.length))
  })

  it('styles every colour: a class sets the dot colour, the chip label and the notebook icon from their tokens', () => {
    const css = read('src/renderer/src/app.css')
    for (const id of TAG_COLORS) {
      expect(css).toContain(
        `.tag-color-${id} {\n  --tag-color: var(--color-tag-${id});\n  --tag-text: var(--color-tag-text-${id});\n  --tag-icon: var(--color-tag-icon-${id});\n}`,
      )
    }
  })

  it('has an AA chip label colour for every colour, light and dark', () => {
    const css = read('src/renderer/src/theme/tokens.css')
    const counts = TAG_COLORS.map((id) => css.split(`--color-tag-text-${id}:`).length - 1)
    expect(counts).toEqual(TAG_COLORS.map(() => 4 * THEME_IDS.length))
  })

  it('names every colour in the message catalog', () => {
    for (const id of TAG_COLORS) expect(en[`tagColor.${id}`]).toBeTruthy()
    expect(en['tagColor.none']).toBeTruthy()
  })
})
