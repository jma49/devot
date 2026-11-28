// Binary <-> standard base64 codec shared by the core, the UI worker wire,
// welcome assets, the iPhone share bridge and the browser web clipper.
// Uses ES2025 Uint8Array.prototype.toBase64 / Uint8Array.fromBase64 where the
// JS engine provides them, with a typed-array ASCII table fallback that avoids
// O(n) string concatenation and call-stack overflow on multi-MiB states.

type NativeBytes = { toBase64?: (this: Uint8Array) => string }
type NativeCodec = { fromBase64?: (text: string) => Uint8Array<ArrayBuffer> }

const ALPHABET = Uint8Array.from(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  (c) => c.charCodeAt(0),
)
const PAD = 0x3d
let ascii: TextDecoder | undefined

export function toBase64(bytes: Uint8Array): string {
  const native = (Uint8Array.prototype as NativeBytes).toBase64
  if (native) return native.call(bytes)
  const full = bytes.length - (bytes.length % 3)
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4)
  let o = 0
  for (let i = 0; i < full; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out[o] = ALPHABET[v >>> 18]!
    out[o + 1] = ALPHABET[(v >>> 12) & 63]!
    out[o + 2] = ALPHABET[(v >>> 6) & 63]!
    out[o + 3] = ALPHABET[v & 63]!
    o += 4
  }
  if (full < bytes.length) {
    const two = full + 1 < bytes.length
    const v = (bytes[full]! << 16) | (two ? bytes[full + 1]! << 8 : 0)
    out[o] = ALPHABET[v >>> 18]!
    out[o + 1] = ALPHABET[(v >>> 12) & 63]!
    out[o + 2] = two ? ALPHABET[(v >>> 6) & 63]! : PAD
    out[o + 3] = PAD
  }
  ascii ??= new TextDecoder()
  return ascii.decode(out)
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as NativeCodec).fromBase64
  if (native) return native(text)
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}
