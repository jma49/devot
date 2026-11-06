import { TEMPLATES_BOOK_ID } from '../books'
import {
  excludeTemplates,
  parseSearch,
  resolveSearch,
  SEARCH_LIMIT,
  shortInTitles,
  tidyExcerpt,
  type SearchClause,
} from '../search'
import type { NoteContext } from './context'
import type { Kernel } from './kernel'
import type { NoteService } from './types'

export function searchMethods(ctx: NoteContext, k: Kernel): Pick<NoteService, 'search'> {
  const { storage } = ctx
  const { saveAll } = k.saving
  return {
    async search(query, scope, lookup) {
      const clauses = parseSearch(query)
      if (clauses.length === 0) return { found: [], capped: false }
      if (lookup?.flush !== false) await saveAll()
      const needs = (...fields: SearchClause['field'][]) =>
        clauses.some((c) => fields.includes(c.field))
      const [books, tags] = await Promise.all([
        scope?.bookId || needs('book', 'bookId') ? storage.listBooks() : [],
        needs('tag', 'tagId', 'hashtag') ? storage.listTags() : [],
      ])
      // `book:` and `bookId:` never name Templates.
      const nameable = books.filter((b) => b.id !== TEMPLATES_BOOK_ID)
      const resolved = resolveSearch(clauses, { books, tags, scope, nameable })
      if (!resolved) return { found: [], capped: false }
      const asked = lookup?.shortInTitles ? shortInTitles(resolved) : resolved
      const hits = await storage.searchNotes(excludeTemplates(asked), SEARCH_LIMIT + 1)
      const found = hits.slice(0, SEARCH_LIMIT).map(({ excerpt, ...note }) => {
        const tidy = excerpt ? tidyExcerpt(excerpt) : ''
        return tidy ? { ...note, excerpt: tidy } : note
      })
      return { found, capped: hits.length > SEARCH_LIMIT }
    },
  }
}
