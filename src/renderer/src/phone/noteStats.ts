import { useEffect, useState } from 'react'
import type { NoteCounts } from '../../../core/noteCounts'
import { COUNTS_DEBOUNCE_MS, type Counter } from '../editor/counts'

const WORDS_A_MINUTE = 200

export interface NoteStats {
  readonly words: number
  readonly characters: number
  readonly readingMinutes: number
}

const NONE: NoteStats = { words: 0, characters: 0, readingMinutes: 1 }

export function statsOf({ words, characters }: NoteCounts): NoteStats {
  return {
    words,
    characters,
    readingMinutes: Math.max(1, Math.ceil(words / WORDS_A_MINUTE)),
  }
}

/** The note's counts, counted by `count` (a stable function) once the text has paused; the note's last value shows meanwhile, and no other note's. */
export function useNoteStats(noteId: string, text: string, count: Counter): NoteStats {
  const [counted, setCounted] = useState({ id: noteId, stats: NONE })
  useEffect(() => {
    let current = true
    const timer = setTimeout(() => {
      void Promise.resolve()
        .then(() => count(text))
        .then((counts) => current && setCounted({ id: noteId, stats: statsOf(counts) }))
        .catch(() => console.warn('W_COUNTS_FAILED'))
    }, COUNTS_DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [noteId, text, count])
  return counted.id === noteId ? counted.stats : NONE
}
