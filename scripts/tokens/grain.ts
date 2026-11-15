// A faint noise tile laid over the gradient backdrops. A dark gradient moves one 8-bit level every
// hundred pixels or so, and WebKit draws gradients without dithering, so the steps show as bands; specks
// of a level or two either way break each step's edge into noise the eye averages away.

/** Tile width and height in pixels. */
export const GRAIN_SIZE = 64

/** The strongest speck, in 8-bit alpha levels of white (lighter) or black (darker). */
export const GRAIN_LEVELS = 3

const SEED = 0x6772616e

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

/** Palette index 0 is clear, 1..LEVELS white and LEVELS+1..2*LEVELS black, each at its level's alpha. */
function palette(): { rgb: number[]; alpha: number[] } {
  const rgb = [0, 0, 0]
  const alpha = [0]
  for (const shade of [255, 0]) {
    for (let level = 1; level <= GRAIN_LEVELS; level++) {
      rgb.push(shade, shade, shade)
      alpha.push(level)
    }
  }
  return { rgb, alpha }
}

/** A step from -LEVELS to LEVELS, triangular around 0 (the difference of two even draws). */
function indexFor(next: () => number): number {
  const draw = () => Math.floor(next() * (GRAIN_LEVELS + 1))
  const step = draw() - draw()
  if (step === 0) return 0
  return step > 0 ? step : GRAIN_LEVELS - step
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: number[]): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const uint32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]

function chunk(type: string, body: number[]): number[] {
  const typed = [...type].map((c) => c.charCodeAt(0)).concat(body)
  return [...uint32(body.length), ...typed, ...uint32(crc32(typed))]
}

/** A zlib stream of stored (uncompressed) blocks: the tile is small, and this needs no zlib. */
function zlibStored(data: number[]): number[] {
  const out = [0x78, 0x01]
  for (let at = 0; at < data.length || at === 0; at += 0xffff) {
    const block = data.slice(at, at + 0xffff)
    const last = at + 0xffff >= data.length ? 1 : 0
    out.push(
      last,
      block.length & 0xff,
      block.length >>> 8,
      ~block.length & 0xff,
      (~block.length >>> 8) & 0xff,
    )
    out.push(...block)
  }
  let a = 1
  let b = 0
  for (const byte of data) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  return [...out, ...uint32(((b << 16) | a) >>> 0)]
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

/** The tile as a 4-bit indexed PNG. */
export function grainPng(): Uint8Array {
  const next = random(SEED)
  const rows: number[] = []
  for (let y = 0; y < GRAIN_SIZE; y++) {
    rows.push(0)
    for (let x = 0; x < GRAIN_SIZE; x += 2) {
      rows.push((indexFor(next) << 4) | indexFor(next))
    }
  }
  const { rgb, alpha } = palette()
  const header = [...uint32(GRAIN_SIZE), ...uint32(GRAIN_SIZE), 4, 3, 0, 0, 0]
  return Uint8Array.from([
    ...PNG_SIGNATURE,
    ...chunk('IHDR', header),
    ...chunk('PLTE', rgb),
    ...chunk('tRNS', alpha),
    ...chunk('IDAT', zlibStored(rows)),
    ...chunk('IEND', []),
  ])
}

export const GRAIN_URL = `url("data:image/png;base64,${btoa(String.fromCharCode(...grainPng()))}")`
