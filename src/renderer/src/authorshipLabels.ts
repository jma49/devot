// How the UI names a writer (ADR 0007): the name a client gave, always with its kind, so a client
// can never pass for Edit with AI or the owner (risk 4). The HTTP API and Edit with AI have no name
// and show their kind alone.
import type { WriterKind } from '../../core/authorship'
import { currentLocale, format, t } from './i18n'

export interface WriterRef {
  kind: WriterKind
  name: string
}

export function writerLabel(writer: WriterRef): string {
  const kind = t(`authorship.kind.${writer.kind}`)
  return writer.name ? format(t('authorship.writerNamed'), { name: writer.name, kind }) : kind
}

/** One key per writer across sessions, as Undo All groups them. */
export const writerKey = (writer: WriterRef): string => `${writer.kind}:${writer.name}`

/** The writers' labels joined as a list, each once, in the order given. */
export function writersLabel(writers: readonly WriterRef[]): string {
  const labels = [...new Set(writers.map(writerLabel))]
  return new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(labels)
}
