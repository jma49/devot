import { parseColor, toHex, type Rgb } from './contrast'

export interface Hsv {
  /** 0 to below 360. */
  h: number
  s: number
  v: number
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const channel = (n: number) => {
    const k = (n + h / 60) % 6
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255)
  }
  return [channel(5), channel(3), channel(1)]
}

function rgbToHsv([r, g, b]: Rgb): Hsv {
  const [red, green, blue] = [r / 255, g / 255, b / 255]
  const max = Math.max(red, green, blue)
  const spread = max - Math.min(red, green, blue)
  let h = 0
  if (spread > 0) {
    if (max === red) h = ((green - blue) / spread + 6) % 6
    else if (max === green) h = (blue - red) / spread + 2
    else h = (red - green) / spread + 4
  }
  return { h: h * 60, s: max === 0 ? 0 : spread / max, v: max }
}

export const hsvToHex = (hsv: Hsv) => toHex(hsvToRgb(hsv))
export const hexToHsv = (hex: string) => rgbToHsv(parseColor(hex).rgb)

/** What the hex field holds: the colour once it is six digits, `partial` while it can still become one. */
export function readHexDraft(text: string): { hex: string } | 'partial' | 'invalid' {
  const digits = text.trim().replace(/^#/, '')
  if (/^[0-9a-f]{6}$/i.test(digits)) return { hex: `#${digits.toLowerCase()}` }
  return /^[0-9a-f]{0,5}$/i.test(digits) ? 'partial' : 'invalid'
}

const HUE_STOPS = [0, 60, 120, 180, 240, 300, 359]

/** The hue slider's and spectrum's backgrounds: worked out here, since they are the colours they show. */
export const hueGradient = () =>
  `linear-gradient(to right, ${HUE_STOPS.map((h) => hsvToHex({ h, s: 1, v: 1 })).join(', ')})`

export function spectrumGradient(h: number): string {
  const white: Rgb = [255, 255, 255]
  const black: Rgb = [0, 0, 0]
  const ramp = (to: string, from: Rgb) =>
    `linear-gradient(${to}, ${toHex(from)}, ${toHex(from, 0)})`
  const hue = hsvToHex({ h, s: 1, v: 1 })
  return `${ramp('to top', black)}, ${ramp('to right', white)}, linear-gradient(${hue}, ${hue})`
}
