// What the note list says when it has no rows, by the view it shows.
import type { MessageKey } from './i18n'

export const LIST_EMPTY_KINDS = [
  'all',
  'notebook',
  'filter',
  'search',
  'trash',
  'templates',
] as const
export type ListEmptyKind = (typeof LIST_EMPTY_KINDS)[number]

const TEXT: Readonly<Record<ListEmptyKind, { message: MessageKey; tip?: MessageKey }>> = {
  all: { message: 'noteList.empty.all', tip: 'noteList.empty.createTip' },
  notebook: { message: 'noteList.empty.notebook', tip: 'noteList.empty.createTip' },
  filter: { message: 'noteList.empty.filter' },
  search: { message: 'noteList.empty.search', tip: 'noteList.empty.searchTip' },
  trash: { message: 'noteList.empty.trash' },
  templates: { message: 'noteList.empty.templates', tip: 'noteList.empty.templatesTip' },
}

/** The message (and a tip, for some views) for an empty list of `kind`. */
export const listEmpty = (kind: ListEmptyKind) => TEXT[kind]
