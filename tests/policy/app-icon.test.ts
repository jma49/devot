import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { flatten, resolve, type TokenTree } from '../../scripts/tokens/compile'
import { alphaAt, decodePng, pngSize } from '../support/png'

// The app icon from its design sources (design/app-icon/) to what the bundles ship
// (src-tauri/icons/ and the Xcode project's asset catalog). scripts/app-icon/build.sh makes the images.

const ART = 'design/app-icon'
const ICONS = 'src-tauri/icons'
const IOS_SETS = ['src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset', `${ICONS}/ios`]
const DOCUMENT = 'AppIcon.icon'

const readJson = <T>(path: string) => JSON.parse(readFileSync(path, 'utf8')) as T

function files(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? files(path) : [path]
    })
    .sort()
}

const brandColours = (): Set<string> => {
  const base = flatten(readJson<TokenTree>('design/tokens/base.tokens.json'))
  const brand = resolve(
    base.filter((t) => t.path.startsWith('color.brand.')),
    base,
  )
  return new Set(brand.map((t) => (t.value as { hex: string }).hex.toLowerCase()))
}

const longHex = (hex: string) =>
  (hex.length === 4 ? `#${[...hex.slice(1)].map((d) => d + d).join('')}` : hex).toLowerCase()

/** `extended-srgb:r,g,b,a`, as Icon Composer writes a colour. */
const composerHex = (value: string) =>
  `#${value
    .slice('extended-srgb:'.length)
    .split(',')
    .slice(0, 3)
    .map((c) =>
      Math.round(Number(c) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`

function icnsEntries(data: Buffer): Map<string, Buffer> {
  if (data.toString('latin1', 0, 4) !== 'icns') throw new Error('E_TEST_NOT_ICNS')
  const entries = new Map<string, Buffer>()
  for (let at = 8; at < data.length;) {
    const length = data.readUInt32BE(at + 4)
    entries.set(data.toString('latin1', at, at + 4), data.subarray(at + 8, at + length))
    at += length
  }
  return entries
}

const samePixels = (a: Buffer, b: Buffer) => {
  const [x, y] = [decodePng(a), decodePng(b)]
  return (
    x.width === y.width && x.channels === y.channels && Buffer.compare(x.pixels, y.pixels) === 0
  )
}

interface Layer {
  'image-name': string
}
interface ComposerDocument {
  groups: { layers: Layer[] }[]
}

describe('the macOS app icon', () => {
  const bundled = readJson<{ bundle: { icon: string[] } }>('src-tauri/tauri.conf.json').bundle.icon

  it('bundles the Icon Composer document, with the .icns as the fallback, and only files that exist', () => {
    expect(bundled).toContain(`icons/${DOCUMENT}`)
    expect(bundled).toContain('icons/icon.icns')
    expect(bundled.filter((path) => !existsSync(join('src-tauri', path)))).toEqual([])
  })

  it('ships the Icon Composer document of the design unchanged', () => {
    const design = join(ART, DOCUMENT)
    const shipped = join(ICONS, DOCUMENT)
    const names = (dir: string) => files(dir).map((path) => relative(dir, path))
    expect(names(shipped)).toEqual(names(design))
    const changed = names(design).filter(
      (name) => !readFileSync(join(shipped, name)).equals(readFileSync(join(design, name))),
    )
    expect(changed).toEqual([])
  })

  it('has an Icon Composer document whose layers name exactly the images it holds', () => {
    const doc = readJson<ComposerDocument>(join(ICONS, DOCUMENT, 'icon.json'))
    const named = doc.groups.flatMap((group) => group.layers.map((layer) => layer['image-name']))
    expect(named.length).toBeGreaterThan(0)
    expect(readdirSync(join(ICONS, DOCUMENT, 'Assets')).sort()).toEqual([...new Set(named)].sort())
  })

  it('makes every desktop image the size its name gives, the tile inset from the corners', () => {
    const sizes: Record<string, number> = {
      '32x32.png': 32,
      '64x64.png': 64,
      '128x128.png': 128,
      '128x128@2x.png': 256,
      'icon.png': 512,
    }
    const pngs = readdirSync(ICONS).filter((name) => name.endsWith('.png'))
    expect(pngs.sort()).toEqual(Object.keys(sizes).sort())
    const measured = Object.keys(sizes).map((name) => {
      const data = readFileSync(join(ICONS, name))
      return [name, pngSize(data).width, pngSize(data).height, alphaAt(decodePng(data), 0, 0)]
    })
    expect(measured).toEqual(Object.entries(sizes).map(([name, size]) => [name, size, size, 0]))
  })

  it('holds every size from 16 to 1024 px in the .icns, the same images as the PNGs', () => {
    const entries = icnsEntries(readFileSync(join(ICONS, 'icon.icns')))
    const png = (name: string) => readFileSync(join(ICONS, name))
    const sized: Record<string, number> = {
      ic11: 32,
      ic12: 64,
      ic07: 128,
      ic13: 256,
      ic08: 256,
      ic14: 512,
      ic09: 512,
      ic10: 1024,
    }
    const measured = Object.keys(sized).map((type) => {
      const entry = entries.get(type)
      return [type, entry ? pngSize(entry).width : 0, entry ? pngSize(entry).height : 0]
    })
    expect(measured).toEqual(Object.entries(sized).map(([type, size]) => [type, size, size]))
    expect(['ic04', 'is32'].some((type) => entries.has(type))).toBe(true)
    expect(['ic05', 'il32'].some((type) => entries.has(type))).toBe(true)
    // 32x32.png is the small cut, so this also checks the .icns uses it.
    const same: Record<string, string> = {
      ic11: '32x32.png',
      ic12: '64x64.png',
      ic07: '128x128.png',
      ic08: '128x128@2x.png',
      ic09: 'icon.png',
    }
    const differ = Object.entries(same).filter(
      ([type, name]) => !samePixels(entries.get(type)!, png(name)),
    )
    expect(differ).toEqual([])
  })
})

describe('the iOS app icon', () => {
  interface Image {
    filename?: string
    size: string
    scale: string
  }
  const [xcode, copy] = IOS_SETS as [string, string]

  it('lists exactly the images the Xcode set holds, each the size it names', () => {
    const images = readJson<{ images: Image[] }>(join(xcode, 'Contents.json')).images
    const listed = images.map((image) => image.filename)
    const held = readdirSync(xcode).filter((name) => name.endsWith('.png'))
    expect(listed.filter((name) => name === undefined)).toEqual([])
    expect([...listed].sort()).toEqual(held.sort())
    const missized = images.filter((image) => {
      const side = parseFloat(image.size) * parseInt(image.scale, 10)
      const { width, height } = pngSize(readFileSync(join(xcode, image.filename!)))
      return width !== side || height !== side
    })
    expect(missized).toEqual([])
  })

  // The device masks the corners itself, and App Store Connect refuses an app icon with an
  // alpha channel even when every pixel is opaque (ITMS-90717).
  it('fills every image edge to edge, in RGB without an alpha channel', () => {
    const withAlpha = IOS_SETS.flatMap(files)
      .filter((path) => path.endsWith('.png'))
      .filter((path) => decodePng(readFileSync(path)).channels !== 3)
    expect(withAlpha).toEqual([])
  })

  it('keeps the copy in src-tauri/icons/ios the same as the Xcode set', () => {
    const pngs = (dir: string) => readdirSync(dir).filter((name) => name.endsWith('.png'))
    expect(pngs(copy).sort()).toEqual(pngs(xcode).sort())
    const changed = pngs(xcode).filter(
      (name) => !readFileSync(join(copy, name)).equals(readFileSync(join(xcode, name))),
    )
    expect(changed).toEqual([])
  })
})

describe('the icon artwork', () => {
  const svgs = files(ART).filter((path) => path.endsWith('.svg'))

  it('draws in brand colours only', () => {
    const brand = brandColours()
    const offenders = svgs.flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)]
        .map((match) => longHex(match[0]))
        .filter((hex) => !brand.has(hex))
        .map((hex) => `${path}: ${hex}`),
    )
    const doc = readFileSync(join(ART, DOCUMENT, 'icon.json'), 'utf8')
    const composer = [...doc.matchAll(/extended-srgb:[\d.,]+/g)]
      .map((match) => composerHex(match[0]))
      .filter((hex) => !brand.has(hex))
      .map((hex) => `icon.json: ${hex}`)
    expect(svgs.length).toBeGreaterThan(0)
    expect([...offenders, ...composer]).toEqual([])
  })

  it('draws the mark as one path, and every word as outlines, so no font is needed', () => {
    expect(readFileSync(join(ART, 'dove.svg'), 'utf8').match(/<path\b/g)).toHaveLength(1)
    expect(
      svgs.filter((path) => /<text\b|font-family|@font-face/.test(readFileSync(path, 'utf8'))),
    ).toEqual([])
  })

  it('is listed in the design README', () => {
    const readme = readFileSync('design/README.md', 'utf8')
    const missing = readdirSync(ART).filter((name) => !readme.includes(`\`app-icon/${name}`))
    expect(missing).toEqual([])
  })

  it('is what the README shows', () => {
    const src = /<img src="([^"]+)"[^>]*alt="Devot app icon"/.exec(
      readFileSync('README.md', 'utf8'),
    )?.[1]
    expect(src).toBeDefined()
    expect(existsSync(src!)).toBe(true)
  })
})
