import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { compile, type TokenTree } from '../../scripts/tokens/compile.ts'
import { GRAIN_LEVELS, GRAIN_SIZE, GRAIN_URL, grainPng } from '../../scripts/tokens/grain.ts'

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as TokenTree
const base = read('design/tokens/base.tokens.json')
const light = read('design/tokens/themes/system.light.tokens.json')
const dark = read('design/tokens/themes/system.dark.tokens.json')

interface Decoded {
  width: number
  height: number
  palette: [number, number, number, number][]
  indices: number[]
}

function crc32(bytes: Uint8Array): number {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function decode(png: Uint8Array): Decoded {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  const chunks = new Map<string, Uint8Array>()
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at)
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8))
    const body = png.subarray(at + 8, at + 8 + length)
    expect(view.getUint32(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)))
    chunks.set(type, body)
    at += 12 + length
  }
  const header = new DataView(chunks.get('IHDR')!.buffer, chunks.get('IHDR')!.byteOffset)
  const [width, height] = [header.getUint32(0), header.getUint32(4)]
  expect([header.getUint8(8), header.getUint8(9)]).toEqual([4, 3])
  const rgb = chunks.get('PLTE')!
  const alpha = chunks.get('tRNS')!
  const palette = Array.from({ length: rgb.length / 3 }, (_, i) => [
    rgb[i * 3]!,
    rgb[i * 3 + 1]!,
    rgb[i * 3 + 2]!,
    alpha[i] ?? 255,
  ]) as Decoded['palette']
  const raw = inflateSync(chunks.get('IDAT')!)
  const stride = 1 + Math.ceil(width / 2)
  const indices: number[] = []
  for (let y = 0; y < height; y++) {
    expect(raw[y * stride]).toBe(0)
    for (let x = 0; x < width; x++) {
      const byte = raw[y * stride + 1 + (x >> 1)]!
      indices.push(x % 2 === 0 ? byte >> 4 : byte & 15)
    }
  }
  return { width, height, palette, indices }
}

/** Each pixel's signed step: +n is white at n/255 alpha, -n black at n/255. */
const steps = ({ palette, indices }: Decoded) =>
  indices.map((i) => {
    const [r, g, b, a] = palette[i]!
    expect(r === g && g === b && (r === 0 || r === 255)).toBe(true)
    return r === 255 ? a : -a
  })

describe('backdrop grain', () => {
  const decoded = decode(grainPng())

  it('is a square tile of white and black specks no stronger than the grain levels', () => {
    expect([decoded.width, decoded.height]).toEqual([GRAIN_SIZE, GRAIN_SIZE])
    const values = steps(decoded)
    expect(Math.max(...values.map(Math.abs))).toBe(GRAIN_LEVELS)
  })

  it('lightens and darkens alike, so the gradient keeps its colour on average', () => {
    const values = steps(decoded)
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length
    expect(Math.abs(mean)).toBeLessThan(0.1)
    const share = (test: (v: number) => boolean) => values.filter(test).length / values.length
    expect(share((v) => v > 0)).toBeGreaterThan(0.3)
    expect(share((v) => v < 0)).toBeGreaterThan(0.3)
  })

  it('has no visible pattern: neighbouring pixels are uncorrelated', () => {
    const values = steps(decoded)
    let pairs = 0
    let products = 0
    let squares = 0
    for (let i = 0; i < values.length; i++) {
      squares += values[i]! ** 2
      if ((i + 1) % GRAIN_SIZE !== 0) {
        products += values[i]! * values[i + 1]!
        pairs++
      }
    }
    expect(Math.abs(products / pairs / (squares / values.length))).toBeLessThan(0.05)
  })

  it('comes out the same every build, so the stale-output check holds', () => {
    expect(grainPng()).toEqual(grainPng())
    expect(GRAIN_URL).toBe(
      `url("data:image/png;base64,${Buffer.from(grainPng()).toString('base64')}")`,
    )
  })

  it('lies over every gradient theme backdrop, and is defined only when there is one', () => {
    const backdrops = read('design/tokens/backdrops.tokens.json')
    const plain = compile(base, light, dark).css
    expect(plain).not.toContain('--backdrop-grain')

    const { css } = compile(base, light, dark, [], backdrops)
    const root = css.slice(0, css.indexOf('}'))
    expect(root).toContain(`  --backdrop-grain: ${GRAIN_URL};`)
    const backdropLines = css.split('\n').filter((line) => line.includes('--backdrop:'))
    expect(backdropLines.length).toBeGreaterThan(0)
    for (const line of backdropLines) {
      expect(line).toMatch(/^\s+--backdrop: var\(--backdrop-grain\), linear-gradient\(/)
    }
  })
})
