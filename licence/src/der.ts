/** A DER reader for the parts of X.509 the App Store's certificates use: no BER, no long tags. */

export interface Tlv {
  tag: number
  /** The whole element, header included, as the signature over it covers. */
  bytes: Uint8Array
  content: Uint8Array
}

export const TAG = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  oid: 0x06,
  utcTime: 0x17,
  generalizedTime: 0x18,
  sequence: 0x30,
} as const

export class DerError extends Error {}

export function readTlv(bytes: Uint8Array, offset = 0): Tlv {
  const tag = bytes[offset]
  const first = bytes[offset + 1]
  if (tag === undefined || first === undefined || (tag & 0x1f) === 0x1f) throw new DerError()
  let length = first
  let header = 2
  if (first & 0x80) {
    const count = first & 0x7f
    if (count === 0 || count > 3) throw new DerError()
    length = 0
    for (let i = 0; i < count; i++) {
      const byte = bytes[offset + 2 + i]
      if (byte === undefined) throw new DerError()
      length = length * 256 + byte
    }
    if (length < 0x80) throw new DerError()
    header += count
  }
  const end = offset + header + length
  if (end > bytes.length) throw new DerError()
  return {
    tag,
    bytes: bytes.subarray(offset, end),
    content: bytes.subarray(offset + header, end),
  }
}

/** The one element `bytes` holds, with nothing after it. */
export function readOnly(bytes: Uint8Array, tag: number): Tlv {
  const tlv = readTlv(bytes)
  if (tlv.tag !== tag || tlv.bytes.length !== bytes.length) throw new DerError()
  return tlv
}

export function children(tlv: Tlv): Tlv[] {
  const out: Tlv[] = []
  let offset = 0
  while (offset < tlv.content.length) {
    const child = readTlv(tlv.content, offset)
    out.push(child)
    offset += child.bytes.length
  }
  return out
}

export function expect(tlv: Tlv | undefined, tag: number): Tlv {
  if (tlv?.tag !== tag) throw new DerError()
  return tlv
}

export function oidOf(tlv: Tlv | undefined): string {
  const content = expect(tlv, TAG.oid).content
  if (content.length === 0) throw new DerError()
  const parts: number[] = []
  let value = 0
  for (const byte of content) {
    value = value * 128 + (byte & 0x7f)
    if (value > Number.MAX_SAFE_INTEGER / 128) throw new DerError()
    if (!(byte & 0x80)) {
      parts.push(value)
      value = 0
    }
  }
  if (content[content.length - 1]! & 0x80) throw new DerError()
  const head = parts.shift() ?? 0
  const first = head < 80 ? Math.floor(head / 40) : 2
  return [first, head - first * 40, ...parts].join('.')
}

/** Milliseconds since the epoch, from a UTCTime or a GeneralizedTime in UTC. */
export function timeOf(tlv: Tlv | undefined): number {
  if (!tlv) throw new DerError()
  const text = new TextDecoder().decode(tlv.content)
  let match: RegExpExecArray | null
  let year: number
  if (tlv.tag === TAG.utcTime) {
    match = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text)
    if (!match) throw new DerError()
    const short = Number(match[1])
    year = short < 50 ? 2000 + short : 1900 + short
  } else if (tlv.tag === TAG.generalizedTime) {
    match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text)
    if (!match) throw new DerError()
    year = Number(match[1])
  } else {
    throw new DerError()
  }
  const [, , month, day, hour, minute, second] = match.map(Number)
  return Date.UTC(year, month! - 1, day, hour, minute, second)
}
