import { inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }

export interface Png {
  width: number
  height: number
  channels: number
  pixels: Uint8Array
}

export function pngSize(data: Buffer): { width: number; height: number } {
  if (!data.subarray(0, 8).equals(SIGNATURE)) throw new Error('E_TEST_NOT_PNG')
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

function predict(filter: number, a: number, b: number, c: number): number {
  switch (filter) {
    case 0:
      return 0
    case 1:
      return a
    case 2:
      return b
    case 3:
      return (a + b) >> 1
    case 4:
      return paeth(a, b, c)
    default:
      throw new Error(`E_TEST_PNG_FILTER ${filter}`)
  }
}

/** 8-bit, non-interlaced, without a palette: what the icon generators write. */
export function decodePng(data: Buffer): Png {
  const { width, height } = pngSize(data)
  const [depth, colorType, interlace] = [data[24]!, data[25]!, data[28]!]
  const channels = CHANNELS[colorType]
  if (depth !== 8 || channels === undefined || interlace !== 0) {
    throw new Error(`E_TEST_PNG_FORMAT ${depth} ${colorType} ${interlace}`)
  }
  const chunks: Buffer[] = []
  for (let at = 8; at < data.length;) {
    const length = data.readUInt32BE(at)
    if (data.toString('latin1', at + 4, at + 8) === 'IDAT') {
      chunks.push(data.subarray(at + 8, at + 8 + length))
    }
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  const pixels = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1)
    const filter = raw[start]!
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels]! : 0
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0
      pixels[y * stride + x] = (raw[start + 1 + x]! + predict(filter, a, b, c)) & 0xff
    }
  }
  return { width, height, channels, pixels }
}

export function alphaAt(png: Png, x: number, y: number): number {
  if (png.channels === 1 || png.channels === 3) return 255
  return png.pixels[(y * png.width + x) * png.channels + png.channels - 1]!
}
