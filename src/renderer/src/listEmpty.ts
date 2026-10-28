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

/** What a list that cannot create notes says instead of its create tip. */
const READ_ONLY_TIP: Partial<Record<ListEmptyKind, MessageKey>> = {
  all: 'noteList.empty.readOnly',
  notebook: 'noteList.empty.readOnly',
  templates: 'noteList.empty.templatesReadOnly',
}

export const listEmpty = (kind: ListEmptyKind, editing = true) => {
  const text = TEXT[kind]
  if (editing || !READ_ONLY_TIP[kind]) return text
  return { message: text.message, tip: READ_ONLY_TIP[kind] }
}
