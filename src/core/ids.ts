// UUIDv7 note IDs: time-ordered, so new notes sort after old ones, with a
// counter that keeps IDs from one generator strictly increasing.

export type RandomBytes = (length: number) => Uint8Array

export interface IdGeneratorOptions {
  now?: () => number
  random?: RandomBytes
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

export function createIdGenerator(options: IdGeneratorOptions = {}): () => string {
  const now = options.now ?? Date.now
  const random = options.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n)))
  let lastMs = -1
  let counter = 0

  return () => {
    let ms = Math.max(0, Math.floor(now()))
    if (ms <= lastMs) {
      ms = lastMs
      counter += 1
      if (counter > 0xfff) {
        ms += 1
        counter = 0
      }
    } else {
      counter = 0
    }
    lastMs = ms

    const bytes = new Uint8Array(16)
    let t = ms
    for (let i = 5; i >= 0; i -= 1) {
      bytes[i] = t % 256
      t = Math.floor(t / 256)
    }
    bytes[6] = 0x70 | (counter >> 8)
    bytes[7] = counter & 0xff
    const tail = random(8)
    bytes[8] = 0x80 | ((tail[0] ?? 0) & 0x3f)
    bytes.set(tail.subarray(1, 8), 9)

    const h = hex(bytes)
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
}

export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
