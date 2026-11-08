import type { SearchResult } from '../../../../core/notes/types'
import {
  parseSearch,
  searchValue,
  type SearchClause,
  type SearchField,
  type SearchScope,
} from '../../../../core/search'
import type { ScreensHandlers } from './ops'

/** What the native Search tab asks of the core (docs/specs/iphone-screens.md, Search). */
export interface SearchCore {
  readonly search: (
    query: string,
    scope?: SearchScope,
    options?: { flush?: boolean },
  ) => Promise<SearchResult>
}

const QUALIFIER: Record<Exclude<SearchField, 'any' | 'hashtag'>, string> = {
  title: 'title:',
  body: 'body:',
  book: 'in:',
  tag: 'tag:',
  status: 'is:',
  bookId: 'bookId:',
  tagId: 'tagId:',
  pinned: 'pinned:',
}

const spell = (clause: SearchClause): string => {
  const prefix =
    clause.field === 'any' ? '' : clause.field === 'hashtag' ? '#' : QUALIFIER[clause.field]
  return `${clause.negate ? '-' : ''}${prefix}${searchValue(clause.value)}`
}

const readsAs = (spelled: string, clause: SearchClause) => {
  const [read, ...rest] = parseSearch(spelled)
  return (
    rest.length === 0 &&
    read?.field === clause.field &&
    read.value === clause.value &&
    read.negate === clause.negate
  )
}

/**
 * The query with its plain words and phrases searched in titles only; a clause with a qualifier
 * keeps it. A word no quoting can hold after `title:` stays plain.
 */
export function titlesOnly(query: string): string {
  return parseSearch(query)
    .map((clause) => {
      if (clause.field !== 'any') return spell(clause)
      const titled: SearchClause = { ...clause, field: 'title' }
      const spelled = spell(titled)
      return readsAs(spelled, titled) ? spelled : spell(clause)
    })
    .join(' ')
}

/** Rust has checked the query's length and its scope (`screens::message`). */
export function searchHandlers(core: () => Promise<SearchCore>): ScreensHandlers {
  return {
    search: async (args) => {
      const typed = String(args['query'])
      const query = args['scope'] === 'titles' ? titlesOnly(typed) : typed
      if (parseSearch(query).length === 0) return { rows: [], capped: false }
      const result = await (await core()).search(query, undefined, { flush: true })
      return { rows: result.found, capped: result.capped }
    },
  }
}
