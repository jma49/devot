import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_EDITOR_SETTINGS } from '../../core/editorSettings'
import { IMPORTED_FONT_FAMILY, fontStack, importedFontLoader, type FontEnv } from './fonts'

const stack = (patch: Partial<typeof DEFAULT_EDITOR_SETTINGS>) =>
  fontStack({ ...DEFAULT_EDITOR_SETTINGS, ...patch })

describe('fontStack', () => {
  it('keeps SF Mono as the default and the last fallback of every monospaced font', () => {
    expect(stack({})).toBe('var(--font-family-mono)')
    expect(stack({ fontFamily: 'system' })).toBe('var(--font-family-ui)')
    for (const fontFamily of ['menlo', 'monaco', 'courierNew'] as const)
      expect(stack({ fontFamily })).toMatch(/, var\(--font-family-mono\)$/)
  })

  it('names an installed font, then SF Mono', () => {
    expect(stack({ fontFamily: 'installed', installedFont: 'PT Mono' })).toBe(
      '"PT Mono", var(--font-family-mono)',
    )
    expect(stack({ fontFamily: 'installed', installedFont: null })).toBe('var(--font-family-mono)')
  })

  it('names the imported font face, then SF Mono', () => {
    expect(stack({ fontFamily: 'imported', importedFont: 'Fira Code.ttf' })).toBe(
      `"${IMPORTED_FONT_FAMILY}", var(--font-family-mono)`,
    )
    expect(stack({ fontFamily: 'imported', importedFont: null })).toBe('var(--font-family-mono)')
  })
})

/** A font env whose reads come from `files` (a missing name rejects). */
function env(files: Record<string, string>) {
  const added = new Set<FontFace>()
  const fake: FontEnv = {
    read: (id) =>
      id in files
        ? Promise.resolve(new TextEncoder().encode(files[id]).buffer)
        : Promise.reject(new Error('E_FONT_MISSING')),
    load: (family, bytes) =>
      new TextDecoder().decode(bytes) === 'font'
        ? Promise.resolve({ family } as FontFace)
        : Promise.reject(new Error('invalid')),
    add: (face) => void added.add(face),
    remove: (face) => void added.delete(face),
  }
  return { fake, added }
}

describe('importedFontLoader', () => {
  it('loads the imported font face and swaps it when another is chosen', async () => {
    const { fake, added } = env({ 'a.ttf': 'font', 'b.otf': 'font' })
    const loader = importedFontLoader(fake)
    expect(await loader.use('a.ttf')).toBe(true)
    expect([...added].map((f) => f.family)).toEqual([IMPORTED_FONT_FAMILY])
    expect(await loader.use('b.otf')).toBe(true)
    expect(added.size).toBe(1)
    expect(await loader.use(null)).toBe(true)
    expect(added.size).toBe(0)
  })

  it('falls back (no face) when the file is missing or invalid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fake, added } = env({ 'bad.ttf': 'html', 'a.ttf': 'font' })
    const loader = importedFontLoader(fake)
    await loader.use('a.ttf')
    expect(await loader.use('gone.ttf')).toBe(false)
    expect(added.size).toBe(0)
    expect(await loader.use('bad.ttf')).toBe(false)
    expect(added.size).toBe(0)
    expect(warn).toHaveBeenCalledWith('W_FONT_LOAD_FAILED')
    warn.mockRestore()
  })

  it('lets the newest choice win over one still loading', async () => {
    const { fake, added } = env({ 'a.ttf': 'font', 'b.ttf': 'font' })
    const loader = importedFontLoader(fake)
    const first = loader.use('a.ttf')
    const second = loader.use('b.ttf')
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(added.size).toBe(1)
  })
})
