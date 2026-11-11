// The grain laid over the backdrop gradients (design/README.md, Gradient themes): browsers draw a
// gradient in 8-bit colour without dithering, so a dark, gentle one shows as flat steps.
// White and black specks, each at most about one 8-bit level of colour, break the steps up.
import { crc32 } from 'node:zlib'

export const GRAIN_SIZE = 64
/** Out of 255: 2% at the strongest speck. */
export const GRAIN_MAX_ALPHA = 5
const SEED = 0x5eed

function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const sum = Buffer.alloc(4)
  sum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, sum])
}

function adler32(data: Buffer): number {
  let a = 1
  let b = 0
  for (const byte of data) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

/** Stored (uncompressed) deflate: the same bytes whichever zlib the machine has. */
function zlibStored(data: Buffer): Buffer {
  if (data.length > 0xffff) throw new Error('E_TOKEN_GRAIN_SIZE')
  const head = Buffer.from([0x78, 0x01, 0x01, 0, 0, 0, 0])
  head.writeUInt16LE(data.length, 3)
  head.writeUInt16LE(~data.length & 0xffff, 5)
  const sum = Buffer.alloc(4)
  sum.writeUInt32BE(adler32(data), 0)
  return Buffer.concat([head, data, sum])
}

/** The tile as a grey-and-alpha PNG data URI, the same on every run. */
export function grainTile(): string {
  const next = random(SEED)
  const rows = Buffer.alloc(GRAIN_SIZE * (1 + GRAIN_SIZE * 2))
  for (let y = 0; y < GRAIN_SIZE; y += 1) {
    const start = y * (1 + GRAIN_SIZE * 2)
    for (let x = 0; x < GRAIN_SIZE; x += 1) {
      rows[start + 1 + x * 2] = next() < 0.5 ? 0 : 255
      rows[start + 2 + x * 2] = Math.floor(next() * (GRAIN_MAX_ALPHA + 1))
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(GRAIN_SIZE, 0)
  header.writeUInt32BE(GRAIN_SIZE, 4)
  header.set([8, 4, 0, 0, 0], 8)
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', zlibStored(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${png.toString('base64')}`
}
