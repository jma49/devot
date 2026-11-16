// A `.zip` of a package's files, deflated, in name order with a fixed time, so packing the same files gives the same bytes.
import { crc32, deflateRawSync } from 'node:zlib'

// 1980-01-01 00:00, the earliest time the format holds.
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1
const UTF8_NAMES = 0x0800
const DEFLATE = 8
const VERSION = 20

export function zip(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const name of [...files.keys()].sort()) {
    const data = files.get(name)!
    const path = new TextEncoder().encode(name)
    const packed = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, VERSION, true)
    local.setUint16(6, UTF8_NAMES, true)
    local.setUint16(8, DEFLATE, true)
    local.setUint16(10, DOS_TIME, true)
    local.setUint16(12, DOS_DATE, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, packed.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, path.length, true)
    local.setUint16(28, 0, true)
    const entry = new DataView(new ArrayBuffer(46))
    entry.setUint32(0, 0x02014b50, true)
    entry.setUint16(4, VERSION, true)
    entry.setUint16(6, VERSION, true)
    entry.setUint16(8, UTF8_NAMES, true)
    entry.setUint16(10, DEFLATE, true)
    entry.setUint16(12, DOS_TIME, true)
    entry.setUint16(14, DOS_DATE, true)
    entry.setUint32(16, crc, true)
    entry.setUint32(20, packed.length, true)
    entry.setUint32(24, data.length, true)
    entry.setUint16(28, path.length, true)
    entry.setUint32(42, offset, true)
    parts.push(new Uint8Array(local.buffer), path, packed)
    central.push(new Uint8Array(entry.buffer), path)
    offset += 30 + path.length + packed.length
  }
  const size = central.reduce((n, p) => n + p.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, files.size, true)
  end.setUint16(10, files.size, true)
  end.setUint32(12, size, true)
  end.setUint32(16, offset, true)
  return Buffer.concat([...parts, ...central, new Uint8Array(end.buffer)])
}
