// Semantic search (docs/specs/search.md, Semantic search): the query's words are read for their
// meaning by the system's sentence model on the device, and the search's other conditions keep
// the notes the view shows. Storage ranks the passages (src-tauri/src/semantic).

import type { NoteQuery, NoteSummary } from './storage'

/** A query's text (the Rust command's MAX_TEXT_CHARS). */
export const MAX_SEMANTIC_TEXT = 1000
/** Results one search returns (MAX_RESULTS). */
export const MAX_SEMANTIC_RESULTS = 50
/** Shorter text has too little meaning to rank by. */
export const MIN_SEMANTIC_TEXT = 3

export interface SemanticQuery {
  text: string
  /** The search's other conditions; a text condition here is always negated. */
  filter: NoteQuery
  limit: number
  /** Each hit carries its whole passage (for a question to a model), not its excerpt alone. */
  passages: boolean
}

export interface SemanticHit extends NoteSummary {
  /** The passage's cosine similarity to the query, -1 to 1. */
  score: number
  passage?: string
}

export type SemanticStatus =
  | { state: 'starting' | 'unavailable' | 'locked' }
  | { state: 'indexing'; done: number; total: number }
  | { state: 'ready'; notes: number }

/**
 * The words a resolved query asks for, read for their meaning, and the rest as its filter; null
 * when it asks for no words, or too few to rank by.
 */
export function semanticQuery(
  query: NoteQuery,
  limit: number,
  passages = false,
): SemanticQuery | null {
  const words = query.text.filter((t) => !t.negate).map((t) => t.value.trim())
  const text = words.filter(Boolean).join(' ').slice(0, MAX_SEMANTIC_TEXT).trim()
  if ([...text].length < MIN_SEMANTIC_TEXT) return null
  return {
    text,
    filter: { ...query, text: query.text.filter((t) => t.negate) },
    limit: Math.max(1, Math.min(limit, MAX_SEMANTIC_RESULTS)),
    passages,
  }
}
