import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_EDITOR_SETTINGS, slotFont, type FontSlot } from '../../core/editorSettings'
import { fontStack, importedFontFamily, importedFontLoader, type FontEnv } from './fonts'

const stack = (patch: Partial<typeof DEFAULT_EDITOR_SETTINGS>, slot: FontSlot = 'note') =>
  fontStack(slotFont({ ...DEFAULT_EDITOR_SETTINGS, ...patch }, slot), slot)

describe('fontStack', () => {
  it('keeps SF Mono as the default and the last fallback of every monospaced font', () => {
    expect(stack({})).toBe('var(--font-family-mono)')
    expect(stack({}, 'code')).toBe('var(--font-family-mono)')
    // The system font is the token's list, whatever the app font is.
    expect(stack({ fontFamily: 'system' })).toMatch(/^-apple-system/)
    for (const fontFamily of ['menlo', 'monaco', 'courierNew'] as const)
      expect(stack({ fontFamily })).toMatch(/, var\(--font-family-mono\)$/)
  })

  it('names an installed font, then the slot default', () => {
    expect(stack({ fontFamily: 'installed', installedFont: 'PT Mono' })).toBe(
      '"PT Mono", var(--font-family-mono)',
    )
    expect(stack({ fontFamily: 'installed', installedFont: null })).toBe('var(--font-family-mono)')
    expect(stack({}, 'app')).toMatch(/^-apple-system/)
    expect(stack({ appFontFamily: 'installed', appInstalledFont: 'Avenir Next' }, 'app')).toMatch(
      /^"Avenir Next", -apple-system/,
    )
  })

  it('names the imported file under a family of its own once it has loaded', () => {
    const font = slotFont(
      { ...DEFAULT_EDITOR_SETTINGS, fontFamily: 'imported', importedFont: 'Fira Code.ttf' },
      'note',
    )
    expect(fontStack(font, 'note')).toBe('"Devot Font Fira Code ttf", var(--font-family-mono)')
    expect(fontStack(font, 'note', () => false)).toBe('var(--font-family-mono)')
    expect(importedFontFamily('a.ttf')).not.toBe(importedFontFamily('a.otf'))
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
  it('loads a face per file under its own family and swaps it when another is chosen', async () => {
    const { fake, added } = env({ 'a.ttf': 'font', 'b.otf': 'font' })
    const loaded = vi.fn<() => void>()
    const loader = importedFontLoader(fake, loaded)
    expect(await loader.use('note', 'a.ttf')).toBe(true)
    expect([...added].map((f) => f.family)).toEqual([importedFontFamily('a.ttf')])
    expect(loader.has('a.ttf')).toBe(true)
    expect(loaded).toHaveBeenCalledTimes(1)
    expect(await loader.use('note', 'b.otf')).toBe(true)
    expect([...added].map((f) => f.family)).toEqual([importedFontFamily('b.otf')])
    expect(loader.has('a.ttf')).toBe(false)
    expect(await loader.use('note', null)).toBe(true)
    expect(added.size).toBe(0)
  })

  it('keeps one face per slot, shared by slots that use the same file', async () => {
    const { fake, added } = env({ 'a.ttf': 'font', 'b.ttf': 'font' })
    const loader = importedFontLoader(fake)
    await Promise.all([loader.use('app', 'a.ttf'), loader.use('code', 'b.ttf')])
    expect(await loader.use('note', 'a.ttf')).toBe(true)
    expect(added.size).toBe(2)
    await loader.use('app', null)
    // The note font still uses a.ttf.
    expect(loader.has('a.ttf')).toBe(true)
    await loader.use('note', null)
    expect([...added].map((f) => f.family)).toEqual([importedFontFamily('b.ttf')])
  })

  it('falls back (no face) when the file is missing or invalid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fake, added } = env({ 'bad.ttf': 'html', 'a.ttf': 'font' })
    const loader = importedFontLoader(fake)
    await loader.use('note', 'a.ttf')
    expect(await loader.use('note', 'gone.ttf')).toBe(false)
    expect(added.size).toBe(0)
    expect(await loader.use('note', 'bad.ttf')).toBe(false)
    expect(added.size).toBe(0)
    // Not tried again while it stays chosen.
    expect(await loader.use('note', 'bad.ttf')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith('W_FONT_LOAD_FAILED')
    warn.mockRestore()
  })

  it('lets the newest choice win over one still loading', async () => {
    const { fake, added } = env({ 'a.ttf': 'font', 'b.ttf': 'font' })
    const loader = importedFontLoader(fake)
    const first = loader.use('note', 'a.ttf')
    const second = loader.use('note', 'b.ttf')
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(added.size).toBe(1)
  })

  it('keeps one face when the choice goes away and back while loading', async () => {
    const { fake, added } = env({ 'a.ttf': 'font', 'b.ttf': 'font' })
    const loader = importedFontLoader(fake)
    const results = await Promise.all([
      loader.use('note', 'a.ttf'),
      loader.use('note', 'b.ttf'),
      loader.use('note', 'a.ttf'),
    ])
    expect(results).toEqual([true, false, true])
    expect([...added].map((f) => f.family)).toEqual([importedFontFamily('a.ttf')])
  })
})
