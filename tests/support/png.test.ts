import { deflateSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { alphaAt, decodePng, pngSize } from './png'

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Encodes RGBA rows, row y with filter y % 5, so every filter is decoded. */
function encode(width: number, rows: number[][]): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(rows.length, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const raw = rows.flatMap((row, y) => {
    const filter = y % 5
    const above = rows[y - 1] ?? []
    return [
      filter,
      ...row.map((value, x) => {
        const a = row[x - 4] ?? 0
        const b = above[x] ?? 0
        const c = above[x - 4] ?? 0
        const predicted = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]!
        return (value - predicted) & 0xff
      }),
    ]
  })
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

it('reads the size from the header and decodes every row filter', () => {
  const rows = Array.from({ length: 6 }, (_row, y) =>
    Array.from({ length: 3 * 4 }, (_byte, x) => (x * 37 + y * 91 + 13) & 0xff),
  )
  const data = encode(3, rows)
  expect(pngSize(data)).toEqual({ width: 3, height: 6 })
  const png = decodePng(data)
  expect([...png.pixels]).toEqual(rows.flat())
  expect(alphaAt(png, 2, 5)).toBe(rows[5]![11])
})

it('refuses what is not a PNG', () => {
  expect(() => pngSize(Buffer.from('GIF89a and more bytes than a header'))).toThrow(
    'E_TEST_NOT_PNG',
  )
})
