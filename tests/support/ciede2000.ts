import type { Rgb } from '../../src/renderer/src/theme/contrast'

export type Lab = [number, number, number]

const linear = (value: number) => {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

const D65 = [0.95047, 1, 1.08883] as const

export function srgbToLab([r, g, b]: Rgb): Lab {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)]
  const xyz = [
    0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb,
    0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb,
    0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb,
  ]
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
  const [fx, fy, fz] = xyz.map((v, i) => f(v / D65[i]!)) as [number, number, number]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

const rad = (deg: number) => (deg * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI
const hue = (b: number, a: number) => (a === 0 && b === 0 ? 0 : (deg(Math.atan2(b, a)) + 360) % 360)

/** CIEDE2000 colour difference, with kL = kC = kH = 1. */
export function ciede2000([L1, a1, b1]: Lab, [L2, a2, b2]: Lab): number {
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)))
  const [ap1, ap2] = [(1 + g) * a1, (1 + g) * a2]
  const [cp1, cp2] = [Math.hypot(ap1, b1), Math.hypot(ap2, b2)]
  const [hp1, hp2] = [hue(b1, ap1), hue(b2, ap2)]

  const dL = L2 - L1
  const dC = cp2 - cp1
  let dh = 0
  if (cp1 * cp2 !== 0) {
    dh = hp2 - hp1
    if (dh > 180) dh -= 360
    else if (dh < -180) dh += 360
  }
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin(rad(dh / 2))

  const lBar = (L1 + L2) / 2
  const cpBar = (cp1 + cp2) / 2
  let hBar = hp1 + hp2
  if (cp1 * cp2 !== 0) {
    if (Math.abs(hp1 - hp2) <= 180) hBar /= 2
    else hBar = hBar < 360 ? (hBar + 360) / 2 : (hBar - 360) / 2
  }
  const t =
    1 -
    0.17 * Math.cos(rad(hBar - 30)) +
    0.24 * Math.cos(rad(2 * hBar)) +
    0.32 * Math.cos(rad(3 * hBar + 6)) -
    0.2 * Math.cos(rad(4 * hBar - 63))
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2)
  const sc = 1 + 0.045 * cpBar
  const sh = 1 + 0.015 * cpBar * t
  const rt =
    -2 *
    Math.sqrt(cpBar ** 7 / (cpBar ** 7 + 25 ** 7)) *
    Math.sin(rad(60 * Math.exp(-(((hBar - 275) / 25) ** 2))))
  return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 + rt * (dC / sc) * (dH / sh))
}
