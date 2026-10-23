import type { Png } from './png'

export function icnsEntries(data: Buffer): Map<string, Buffer> {
  if (data.toString('latin1', 0, 4) !== 'icns') throw new Error('E_TEST_NOT_ICNS')
  const entries = new Map<string, Buffer>()
  for (let at = 8; at < data.length;) {
    const length = data.readUInt32BE(at + 4)
    entries.set(data.toString('latin1', at, at + 4), data.subarray(at + 8, at + length))
    at += length
  }
  return entries
}

/**
 * Decodes an `ARGB` entry (ic04, ic05: 16 and 32 px): run-length planes of alpha, red, green and
 * blue, returned as RGBA pixels like `decodePng`.
 */
export function icnsArgb(entry: Buffer, size: number): Png {
  if (entry.toString('latin1', 0, 4) !== 'ARGB') throw new Error('E_TEST_ICNS_NOT_ARGB')
  const area = size * size
  const planes = new Uint8Array(4 * area)
  let filled = 0
  for (let at = 4; at < entry.length;) {
    const head = entry[at]!
    const count = head < 0x80 ? head + 1 : head - 0x80 + 3
    if (filled + count > planes.length) throw new Error('E_TEST_ICNS_ARGB_SIZE')
    if (head < 0x80) {
      if (at + 1 + count > entry.length) throw new Error('E_TEST_ICNS_ARGB_SIZE')
      planes.set(entry.subarray(at + 1, at + 1 + count), filled)
      at += 1 + count
    } else {
      planes.fill(entry[at + 1]!, filled, filled + count)
      at += 2
    }
    filled += count
  }
  if (filled !== planes.length) throw new Error('E_TEST_ICNS_ARGB_SIZE')
  const pixels = new Uint8Array(4 * area)
  for (let i = 0; i < area; i++) {
    pixels.set([planes[area + i]!, planes[2 * area + i]!, planes[3 * area + i]!, planes[i]!], 4 * i)
  }
  return { width: size, height: size, channels: 4, pixels }
}
