import { countWords } from '../../../core/words'

const WORDS_A_MINUTE = 200

export interface NoteStats {
  readonly words: number
  readonly characters: number
  readonly readingMinutes: number
}

export function noteStats(markdown: string): NoteStats {
  const words = countWords(markdown)
  return {
    words,
    characters: [...markdown].filter((c) => !/\s/u.test(c)).length,
    readingMinutes: Math.max(1, Math.ceil(words / WORDS_A_MINUTE)),
  }
}
