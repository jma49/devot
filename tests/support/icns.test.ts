import { expect, it } from 'vitest'
import { icnsArgb, icnsEntries } from './icns'

function entry(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.write(type, 0, 'latin1')
  header.writeUInt32BE(data.length + 8, 4)
  return Buffer.concat([header, data])
}

it('splits an .icns file into its entries by type', () => {
  const entries = icnsEntries(
    entry(
      'icns',
      Buffer.concat([entry('ic11', Buffer.from('png')), entry('ic04', Buffer.from('argb'))]),
    ),
  )
  expect([...entries.keys()]).toEqual(['ic11', 'ic04'])
  expect(entries.get('ic04')?.toString('latin1')).toBe('argb')
})

it('refuses what is not an .icns file', () => {
  expect(() => icnsEntries(Buffer.from('not an icon file'))).toThrow('E_TEST_NOT_ICNS')
})

it('decodes an ARGB entry: the run-length planes of alpha, red, green and blue, as RGBA pixels', () => {
  // 2x2 pixels, so 4 bytes a plane. Runs (0x80 + n - 3) repeat one byte n times; literals
  // (n - 1) copy n bytes. One run crosses into the next plane on purpose.
  const packets = [
    [0x81, 0xff], // alpha: 4 x 0xff
    [0x01, 0x10, 0x20], // red: 0x10 0x20 ...
    [0x82, 0x30], // ... 0x30 0x30, then green: 0x30 0x30 0x30
    [0x00, 0x40], // ... 0x40
    [0x03, 0x01, 0x02, 0x03, 0x04], // blue
  ]
  const png = icnsArgb(Buffer.from([...Buffer.from('ARGB'), ...packets.flat()]), 2)
  expect({ width: png.width, height: png.height, channels: png.channels }).toEqual({
    width: 2,
    height: 2,
    channels: 4,
  })
  expect([...png.pixels]).toEqual(
    [
      [0x10, 0x30, 0x01, 0xff],
      [0x20, 0x30, 0x02, 0xff],
      [0x30, 0x30, 0x03, 0xff],
      [0x30, 0x40, 0x04, 0xff],
    ].flat(),
  )
})

it('refuses an entry that is not ARGB or does not hold the size asked for', () => {
  expect(() => icnsArgb(Buffer.from('\x89PNG and the rest', 'latin1'), 2)).toThrow(
    'E_TEST_ICNS_NOT_ARGB',
  )
  const argb = (...planes: number[]) => Buffer.from([...Buffer.from('ARGB'), ...planes])
  expect(() => icnsArgb(argb(0x8e, 0x00), 2)).toThrow('E_TEST_ICNS_ARGB_SIZE')
  expect(() => icnsArgb(argb(0x8e, 0x00), 3)).toThrow('E_TEST_ICNS_ARGB_SIZE')
  expect(() => icnsArgb(argb(0x8b, 0x00, 0x03, 0x01), 2)).toThrow('E_TEST_ICNS_ARGB_SIZE')
})
