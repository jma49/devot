import { noteCounts } from '../../../core/noteCounts'

const WORDS_A_MINUTE = 200

export interface NoteStats {
  readonly words: number
  readonly characters: number
  readonly readingMinutes: number
}

export function noteStats(markdown: string): NoteStats {
  const { words, characters } = noteCounts(markdown)
  return { words, characters, readingMinutes: Math.max(1, Math.ceil(words / WORDS_A_MINUTE)) }
}
