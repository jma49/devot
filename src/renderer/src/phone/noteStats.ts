const WORDS_A_MINUTE = 200
// A CJK character reads as a word of its own; other text splits on whitespace.
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/gu

export interface NoteStats {
  readonly words: number
  readonly characters: number
  readonly readingMinutes: number
}

export function noteStats(markdown: string): NoteStats {
  const cjk = markdown.match(CJK)?.length ?? 0
  const rest = markdown
    .replace(CJK, ' ')
    .split(/\s+/u)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  const words = cjk + rest
  return {
    words,
    characters: [...markdown].filter((c) => !/\s/u.test(c)).length,
    readingMinutes: Math.max(1, Math.ceil(words / WORDS_A_MINUTE)),
  }
}
