import { useCallback, useEffect, useRef, useState } from 'react'
import type { NoteSummary } from '../../core'
import { parseSearch, type SearchScope } from '../../core/search'
import { countBucket } from '../../core/usage'
import type { Core } from './core-client'
import { keepUnchanged } from './listUpdates'
import { latestOnly } from './preview/latest'
import { track } from './usage'

export interface Search {
  query: string
  scope: SearchScope | undefined
}

export interface SearchResults {
  found: NoteSummary[]
  capped: boolean
  search: Search
}

/** Notes related to a search by meaning (semantic search), for the search they answer. */
export interface RelatedResults {
  notes: NoteSummary[]
  search: Search
}

const SEARCH_SETTLED_MS = 1000

export function useSearch(core: Core | undefined) {
  const [query, setQuery] = useState('')
  const [searchIn, setSearchIn] = useState<'all' | 'view'>('view')
  const [results, setResults] = useState<SearchResults>()
  const [related, setRelated] = useState<RelatedResults>()
  const searchField = useRef<HTMLInputElement>(null)
  const runSearch = useRef<(search: Search) => void>(undefined)
  const latestSearch = useRef<Search>({ query: '', scope: undefined })
  const [searchRequest, setSearchRequest] = useState(0)
  const askSearchField = useCallback(() => setSearchRequest((n) => n + 1), [])
  useEffect(() => {
    if (!core) return
    let alive = true
    const arm = () => {
      if (!alive) return
      // Asked once a search's own results are in, so they never wait for it.
      const runRelated = latestOnly(
        async (search: Search) => ({
          notes: await core.searchByMeaning(search.query, search.scope),
          search,
        }),
        (next) => {
          if (latestSearch.current !== next.search) return
          setRelated((shown) =>
            shown ? { ...next, notes: keepUnchanged(shown.notes, next.notes) } : next,
          )
        },
        () => console.warn('W_SEMANTIC_SEARCH_FAILED'),
      )
      runSearch.current = latestOnly(
        async (search: Search) => {
          const { found, capped } = await core.search(search.query, search.scope)
          return { found, capped, search }
        },
        // Results that did not change keep their objects (and their rows their render).
        (next) => {
          // An answer that lands after the field was cleared is not kept: the
          // next query would first show it.
          if (!latestSearch.current.query.trim()) return
          setResults((shown) =>
            shown ? { ...next, found: keepUnchanged(shown.found, next.found) } : next,
          )
          runRelated(next.search)
        },
        () => console.warn('W_SEARCH_FAILED'),
      )
      // A query typed before the core started had no search to run, and the
      // lists may have loaded before this effect.
      if (latestSearch.current.query.trim()) runSearch.current(latestSearch.current)
    }
    // A UI test holds this back to type a search after the lists load but before it runs.
    const held = DEVOT_UI_TEST
      ? (globalThis as { devotHoldSearch?: Promise<void> }).devotHoldSearch
      : undefined
    if (held) void held.then(arm)
    else arm()
    return () => {
      alive = false
    }
  }, [core])
  const rerunSearch = useCallback(() => {
    if (latestSearch.current.query.trim()) runSearch.current?.(latestSearch.current)
  }, [])
  const typed = useCallback((search: Search) => {
    latestSearch.current = search
    if (!search.query.trim()) return
    const timer = setTimeout(() => runSearch.current?.(search), 120)
    return () => clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (searchRequest === 0) return
    searchField.current?.focus()
    searchField.current?.select()
  }, [searchRequest])
  return {
    query,
    setQuery,
    searchIn,
    setSearchIn,
    results,
    setResults,
    related,
    searchField,
    runSearch,
    latestSearch,
    rerunSearch,
    typed,
    askSearchField,
  }
}

/** Runs the query typed in the view's scope, and counts a search once its results answer it. */
export function useSearchRuns(
  { query, results, typed }: ReturnType<typeof useSearch>,
  { scope: searchScope, inView }: { scope: SearchScope | undefined; inView: boolean },
) {
  useEffect(() => typed({ query, scope: searchScope }), [query, searchScope, typed])
  // A usage event once typing pauses and the results answer the query; results following a change, or the same query in the same place, are not a new search.
  const countedSearch = useRef('')
  useEffect(() => {
    if (!query.trim()) {
      countedSearch.current = ''
      return
    }
    if (results?.search.query !== query || !!results.search.scope !== inView) return
    const key = `${inView ? 'view' : 'all'}\n${query}`
    if (countedSearch.current === key) return
    const { found } = results
    const timer = setTimeout(() => {
      countedSearch.current = key
      track('search.run', {
        scope: inView ? 'view' : 'all',
        clauses: parseSearch(query).length,
        results: countBucket(found.length),
      })
    }, SEARCH_SETTLED_MS)
    return () => clearTimeout(timer)
  }, [query, results, inView])
}
