import { describe, expect, it } from 'vitest'
import { hexToHsv, hsvToHex, hsvToRgb, hueGradient, readHexDraft, spectrumGradient } from './hsv'

describe('hsv', () => {
  it('converts the corners of the colour space', () => {
    expect(hsvToRgb({ h: 0, s: 1, v: 1 })).toEqual([255, 0, 0])
    expect(hsvToRgb({ h: 120, s: 1, v: 1 })).toEqual([0, 255, 0])
    expect(hsvToRgb({ h: 240, s: 1, v: 1 })).toEqual([0, 0, 255])
    expect(hsvToRgb({ h: 60, s: 0, v: 1 })).toEqual([255, 255, 255])
    expect(hsvToRgb({ h: 60, s: 1, v: 0 })).toEqual([0, 0, 0])
  })

  it('round-trips hex', () => {
    for (const hex of ['#ff00aa', '#123456', '#ffffff', '#000000', '#808080', '#fefe01']) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex)
    }
  })

  it('reads a grey with no hue or saturation', () => {
    expect(hexToHsv('#808080')).toMatchObject({ h: 0, s: 0 })
  })
})

describe('readHexDraft', () => {
  it('takes six digits with or without the hash, in lowercase', () => {
    expect(readHexDraft('#FF00AA')).toEqual({ hex: '#ff00aa' })
    expect(readHexDraft('ff00aa')).toEqual({ hex: '#ff00aa' })
    expect(readHexDraft(' #ff00aa ')).toEqual({ hex: '#ff00aa' })
  })

  it('holds a draft on its way there, and refuses what cannot be one', () => {
    for (const text of ['', '#', '#f', 'ff00a']) expect(readHexDraft(text)).toBe('partial')
    for (const text of ['#ggg', 'red', '#ff00aa0', '##ff0000', '#ff 00']) {
      expect(readHexDraft(text)).toBe('invalid')
    }
  })
})

describe('gradients', () => {
  it('runs the hue slider from red round to red', () => {
    expect(hueGradient()).toContain('#ff0000')
    expect(hueGradient()).toContain('#00ff00')
  })

  it('draws the spectrum over its hue', () => {
    expect(spectrumGradient(120)).toContain('#00ff00')
  })
})
