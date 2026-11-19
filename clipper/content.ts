import { extract, type Mode } from './extract'

const target = globalThis as typeof globalThis & {
  devotExtract?: (mode: Mode) => ReturnType<typeof extract>
}
target.devotExtract = (mode) => extract(document, location.href, mode)
