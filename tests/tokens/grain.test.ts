import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { GRAIN_MAX_ALPHA, GRAIN_SIZE, grainTile } from '../../scripts/tokens/grain'

const PNG_SIGNATURE = '89504e470d0a1a0a'

/** The tile's grey and alpha bytes, read back from the data URI. */
function pixels(uri: string): { width: number; height: number; grey: number[]; alpha: number[] } {
  const bytes = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64')
  expect(bytes.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE)
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  expect([...bytes.subarray(24, 26)]).toEqual([8, 4])
  const idat = bytes.indexOf('IDAT')
  const raw = inflateSync(bytes.subarray(idat + 4, idat + 4 + bytes.readUInt32BE(idat - 4)))
  const grey: number[] = []
  const alpha: number[] = []
  for (let row = 0; row < height; row += 1) {
    const start = row * (1 + width * 2)
    expect(raw[start]).toBe(0)
    for (let x = 0; x < width; x += 1) {
      grey.push(raw[start + 1 + x * 2]!)
      alpha.push(raw[start + 2 + x * 2]!)
    }
  }
  return { width, height, grey, alpha }
}

describe('the backdrop grain', () => {
  it('is the same tile on every machine, so the committed tokens never go stale', () => {
    expect(grainTile()).toBe(grainTile())
  })

  it('is a square of white and black specks too faint to see, enough to break up 8-bit steps', () => {
    const uri = grainTile()
    expect(uri.startsWith('data:image/png;base64,')).toBe(true)
    const { width, height, grey, alpha } = pixels(uri)
    expect([width, height]).toEqual([GRAIN_SIZE, GRAIN_SIZE])
    expect(new Set(grey)).toEqual(new Set([0, 255]))
    expect(Math.max(...alpha)).toBe(GRAIN_MAX_ALPHA)
    expect(Math.min(...alpha)).toBe(0)
    const white = grey.filter((g) => g === 255).length / grey.length
    expect(white).toBeGreaterThan(0.45)
    expect(white).toBeLessThan(0.55)
  })
})
