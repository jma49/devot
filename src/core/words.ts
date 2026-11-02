// A CJK character reads as a word of its own; other text splits on whitespace.
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/gu

export function countWords(markdown: string): number {
  const cjk = markdown.match(CJK)?.length ?? 0
  const rest = markdown
    .replace(CJK, ' ')
    .split(/\s+/u)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length
  return cjk + rest
}
