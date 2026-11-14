import { TEMPLATES_BOOK_ID } from '../books'
import { errorCode } from '../errors'
import {
  excludeTemplates,
  parseSearch,
  resolveSearch,
  SEARCH_LIMIT,
  shortInTitles,
  tidyExcerpt,
  type SearchClause,
  type SearchScope,
} from '../search'
import { semanticQuery } from '../semantic'
import type { NoteQuery } from '../storage'
import type { NoteContext } from './context'
import type { Kernel } from './kernel'
import type { NoteService } from './types'

/** Related notes the list shows under a search's own results. */
const RELATED_LIMIT = 20

export function searchMethods(
  ctx: NoteContext,
  k: Kernel,
): Pick<NoteService, 'search' | 'searchByMeaning'> {
  const { storage } = ctx
  const { saveAll } = k.saving
  async function resolved(
    clauses: readonly SearchClause[],
    scope: SearchScope | undefined,
  ): Promise<NoteQuery | null> {
    const needs = (...fields: SearchClause['field'][]) =>
      clauses.some((c) => fields.includes(c.field))
    const [books, tags] = await Promise.all([
      scope?.bookId || needs('book', 'bookId') ? storage.listBooks() : [],
      needs('tag', 'tagId', 'hashtag') ? storage.listTags() : [],
    ])
    // `book:` and `bookId:` never name Templates.
    const nameable = books.filter((b) => b.id !== TEMPLATES_BOOK_ID)
    return resolveSearch(clauses, { books, tags, scope, nameable })
  }
  // Where the system has no sentence model, it never will in this run.
  let unavailable = false
  return {
    async search(query, scope, lookup) {
      const clauses = parseSearch(query)
      if (clauses.length === 0) return { found: [], capped: false }
      if (lookup?.flush !== false) await saveAll()
      const resolvedQuery = await resolved(clauses, scope)
      if (!resolvedQuery) return { found: [], capped: false }
      const asked = lookup?.shortInTitles ? shortInTitles(resolvedQuery) : resolvedQuery
      const hits = await storage.searchNotes(excludeTemplates(asked), SEARCH_LIMIT + 1)
      const found = hits.slice(0, SEARCH_LIMIT).map(({ excerpt, ...note }) => {
        const tidy = excerpt ? tidyExcerpt(excerpt) : ''
        return tidy ? { ...note, excerpt: tidy } : note
      })
      return { found, capped: hits.length > SEARCH_LIMIT }
    },
    async searchByMeaning(query, scope, limit = RELATED_LIMIT) {
      if (!storage.semanticSearch || unavailable) return []
      const clauses = parseSearch(query)
      if (clauses.length === 0) return []
      const resolvedQuery = await resolved(clauses, scope)
      const asked = resolvedQuery && semanticQuery(excludeTemplates(resolvedQuery), limit)
      if (!asked) return []
      try {
        const hits = await storage.semanticSearch(asked)
        return hits.map(({ score: _score, passage: _passage, excerpt, ...note }) => {
          const tidy = excerpt ? tidyExcerpt(excerpt) : ''
          return tidy ? { ...note, excerpt: tidy } : note
        })
      } catch (error) {
        const code = errorCode(error)
        if (code === 'E_SEMANTIC_UNAVAILABLE') unavailable = true
        ctx.options.log?.('I_SEMANTIC_SEARCH_SKIPPED', code)
        return []
      }
    },
  }
}
