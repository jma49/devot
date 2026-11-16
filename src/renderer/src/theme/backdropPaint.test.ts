import { describe, expect, it } from 'vitest'
import { gradientAt, mixTowardsSolid, paintBackdrop, type Paint } from './backdropPaint'
import { backdrops } from './tokens'

const tideDark = backdrops.tide.dark as Paint

/** Premultiplied red, green, blue and alpha, 0 to 255, as WebKit stores a pixel it decodes. */
function premultiplied(data: Uint8ClampedArray, i: number): [number, number, number, number] {
  const a = data[i + 3]!
  return [
    Math.round((data[i]! * a) / 255),
    Math.round((data[i + 1]! * a) / 255),
    Math.round((data[i + 2]! * a) / 255),
    a,
  ]
}

describe('backdrop paint', () => {
  it('mixes each stop towards the middle colour the way color-mix does, premultiplied', () => {
    const paint: Paint = {
      angle: 160,
      solid: [0, 0, 0, 1],
      stops: [
        { color: [200, 100, 0, 0.5], position: 0 },
        { color: [0, 0, 0, 1], position: 1 },
      ],
    }
    expect(mixTowardsSolid(paint, 100).stops[0]!.color).toEqual([200, 100, 0, 0.5])
    expect(mixTowardsSolid(paint, 0).stops[0]!.color).toEqual([0, 0, 0, 1])
    const half = mixTowardsSolid(paint, 50).stops[0]!.color
    expect(half[3]).toBeCloseTo(0.75)
    expect(half[0]).toBeCloseTo((200 * 0.5 * 0.5) / 0.75)
  })

  it('runs the gradient along the CSS gradient line for its angle', () => {
    const paint: Paint = {
      angle: 160,
      solid: [0, 0, 0, 1],
      stops: [
        { color: [0, 0, 0, 1], position: 0 },
        { color: [255, 255, 255, 1], position: 1 },
      ],
    }
    const [w, h] = [400, 300]
    const rad = (160 * Math.PI) / 180
    const length = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad))
    const at = (x: number, y: number) => gradientAt(paint, w, h, x, y)[0]
    expect(at(w / 2, h / 2)).toBeCloseTo(127.5)
    const start = [w / 2 - (Math.sin(rad) * length) / 2, h / 2 + (Math.cos(rad) * length) / 2]
    expect(at(start[0]!, start[1]!)).toBeCloseTo(0)
    expect(at(w - start[0]!, h - start[1]!)).toBeCloseTo(255)
  })

  it('keeps every pixel within one level of the smooth gradient', () => {
    const [w, h] = [320, 200]
    const data = paintBackdrop(tideDark, w, h)
    for (let y = 0; y < h; y += 7) {
      for (let x = 0; x < w; x += 5) {
        const ideal = gradientAt(tideDark, w, h, x + 0.5, y + 0.5)
        const pixel = premultiplied(data, (y * w + x) * 4)
        const a = ideal[3]
        const want = [ideal[0] * a, ideal[1] * a, ideal[2] * a, a * 255]
        pixel.forEach((v, c) => expect(Math.abs(v - want[c]!)).toBeLessThanOrEqual(1))
      }
    }
  })

  it('averages to the smooth gradient over any small patch, so no band survives', () => {
    const [w, h] = [512, 320]
    const data = paintBackdrop(tideDark, w, h)
    const patch = 16
    let worst = 0
    for (let py = 0; py + patch <= h; py += patch) {
      for (let px = 0; px + patch <= w; px += patch) {
        const sum: [number, number, number] = [0, 0, 0]
        const ideal: [number, number, number] = [0, 0, 0]
        for (let y = py; y < py + patch; y++) {
          for (let x = px; x < px + patch; x++) {
            const p = premultiplied(data, (y * w + x) * 4)
            const g = gradientAt(tideDark, w, h, x + 0.5, y + 0.5)
            for (let c = 0; c < 3; c++) {
              sum[c]! += p[c]!
              ideal[c]! += g[c]! * g[3]
            }
          }
        }
        for (let c = 0; c < 3; c++)
          worst = Math.max(worst, Math.abs(sum[c]! - ideal[c]!) / patch ** 2)
      }
    }
    expect(worst).toBeLessThan(0.25)
  })

  it('paints the same pixels every time, so a repaint does not shimmer', () => {
    expect(paintBackdrop(tideDark, 64, 48)).toEqual(paintBackdrop(tideDark, 64, 48))
  })
})
