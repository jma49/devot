import type { FrontMatterView } from './frontMatterView'

/** How many properties the summary counts: a block that is not a map of keys counts as one. */
export const propertyCount = (view: FrontMatterView | null): number =>
  view === null ? 0 : view.kind === 'properties' ? view.rows.length : 1
