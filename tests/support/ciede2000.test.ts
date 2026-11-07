import { describe, expect, it } from 'vitest'
import { ciede2000, srgbToLab, type Lab } from './ciede2000'

describe('ciede2000', () => {
  // Pairs from Sharma, Wu and Dalal (2005), "The CIEDE2000 Color-Difference Formula", table 1.
  const pairs: [Lab, Lab, number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ]

  it.each(pairs)('measures %j against %j as the published value', (a, b, expected) => {
    expect(ciede2000(a, b)).toBeCloseTo(expected, 4)
    expect(ciede2000(b, a)).toBeCloseTo(expected, 4)
  })

  it('converts sRGB to CIELAB under D65', () => {
    const white = srgbToLab([255, 255, 255])
    expect(white[0]).toBeCloseTo(100, 2)
    expect(Math.abs(white[1])).toBeLessThan(0.01)
    expect(Math.abs(white[2])).toBeLessThan(0.01)
    const red = srgbToLab([255, 0, 0])
    expect(red[0]).toBeCloseTo(53.24, 1)
    expect(red[1]).toBeCloseTo(80.09, 1)
    expect(red[2]).toBeCloseTo(67.2, 1)
  })
})
