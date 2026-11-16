// A gradient theme's backdrop painted as pixels. WebKit rounds a CSS gradient to 8 bits per
// channel with no dithering, and the gradient themes change by only a few levels across a window,
// so each level shows as a band. Painted here, every pixel is rounded up or down at random in
// proportion to how close it is to each neighbouring level: no pixel is more than one level off,
// and any small patch averages to the smooth gradient, so the eye sees no steps and no texture.

/** Red, green and blue 0 to 255, alpha 0 to 1. */
export type Colour = readonly [number, number, number, number]

export interface Paint {
  angle: number
  solid: Colour
  stops: readonly { color: Colour; position: number }[]
}

/** CSS `color-mix(in srgb, a share, b)`: premultiplied, then divided back out. */
function mix(a: Colour, b: Colour, share: number): Colour {
  const alpha = a[3] * share + b[3] * (1 - share)
  if (alpha === 0) return [0, 0, 0, 0]
  const channel = (i: number) => (a[i]! * a[3] * share + b[i]! * b[3] * (1 - share)) / alpha
  return [channel(0), channel(1), channel(2), alpha]
}

/** The stops at Settings > Appearance > Gradient's strength, as the compiled `--backdrop` mixes them. */
export function mixTowardsSolid(paint: Paint, strength: number): Paint {
  const share = Math.min(Math.max(strength, 0), 100) / 100
  return {
    ...paint,
    stops: paint.stops.map((s) => ({ ...s, color: mix(s.color, paint.solid, share) })),
  }
}

/** Where (x, y) falls on the gradient line of a CSS `linear-gradient(<angle>deg, …)` over w by h. */
function lineAt(angle: number, w: number, h: number): (x: number, y: number) => number {
  const rad = (angle * Math.PI) / 180
  const [dx, dy] = [Math.sin(rad), -Math.cos(rad)]
  const length = Math.abs(w * dx) + Math.abs(h * dy)
  return (x, y) => ((x - w / 2) * dx + (y - h / 2) * dy) / length + 0.5
}

function colourOn(stops: Paint['stops'], t: number): Colour {
  const first = stops[0]!
  const last = stops.at(-1)!
  if (t <= first.position) return first.color
  if (t >= last.position) return last.color
  const next = stops.findIndex((s) => s.position >= t)
  const [a, b] = [stops[next - 1]!, stops[next]!]
  const span = b.position - a.position
  return mix(b.color, a.color, span === 0 ? 1 : (t - a.position) / span)
}

/** The smooth gradient's colour at (x, y) in a w by h box. */
export function gradientAt(paint: Paint, w: number, h: number, x: number, y: number): Colour {
  return colourOn(paint.stops, lineAt(paint.angle, w, h)(x, y))
}

/** A fixed hash of a pixel, so the same box always paints the same pixels: four 8-bit thresholds. */
function noise(x: number, y: number): number {
  let n = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1)
  n = Math.imul(n ^ (n >>> 15), 0x85ebca6b)
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35)
  return (n ^ (n >>> 16)) >>> 0
}

/** The level a value rounds to, up or down with the odds of how near it is to each; within 0 and max. */
function dither(value: number, bits: number, max: number): number {
  const level = Math.floor(value + ((bits & 0xff) + 0.5) / 256)
  return level < 0 ? 0 : level > max ? max : level
}

/** Samples of the premultiplied gradient along its line; between them it is close to linear. */
const SAMPLES = 4096

/**
 * The backdrop over w by h pixels, as straight (unpremultiplied) RGBA for `ImageData`. Each channel
 * is rounded in premultiplied form, the form WebKit draws in, and stored so that premultiplying it
 * again gives back that rounded value.
 */
export function paintBackdrop(paint: Paint, w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  const table = new Float64Array((SAMPLES + 1) * 4)
  for (let s = 0; s <= SAMPLES; s++) {
    const [r, g, b, a] = colourOn(paint.stops, s / SAMPLES)
    table.set([r * a, g * a, b * a, a * 255], s * 4)
  }
  const data = new Uint8ClampedArray(w * h * 4)
  // One write per pixel, red in the low byte: ImageData is little-endian on every Mac and iPhone.
  const pixels = new Uint32Array(data.buffer)
  const at = lineAt(paint.angle, w, h)
  const dt = (at(1, 0) - at(0, 0)) * SAMPLES
  let i = 0
  for (let y = 0; y < h; y++) {
    let pos = at(0.5, y + 0.5) * SAMPLES
    for (let x = 0; x < w; x++, pos += dt, i++) {
      const p = pos < 0 ? 0 : pos > SAMPLES ? SAMPLES : pos
      const s = p >= SAMPLES ? SAMPLES - 1 : p | 0
      const f = p - s
      const k = s * 4
      const bits = noise(x, y)
      const alpha = dither(table[k + 3]! + (table[k + 7]! - table[k + 3]!) * f, bits >>> 24, 255)
      if (alpha === 0) continue
      const scale = 255 / alpha
      const r = dither(table[k]! + (table[k + 4]! - table[k]!) * f, bits, alpha)
      const g = dither(table[k + 1]! + (table[k + 5]! - table[k + 1]!) * f, bits >>> 8, alpha)
      const b = dither(table[k + 2]! + (table[k + 6]! - table[k + 2]!) * f, bits >>> 16, alpha)
      pixels[i] =
        ((r * scale + 0.5) |
          0 |
          (((g * scale + 0.5) | 0) << 8) |
          (((b * scale + 0.5) | 0) << 16) |
          (alpha << 24)) >>>
        0
    }
  }
  return data
}
