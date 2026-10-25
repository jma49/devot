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

export interface LabelParts {
  before: string
  /** The client's name: the one part a narrow row may cut short. */
  name: string
  after: string
  full: string
}

const around = (text: string, slot: string): [string, string] => {
  const at = text.indexOf(slot)
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + slot.length)]
}

/** `template` with the writer's label for `{writer}`, split around the name so the kind stays shown. */
export function writerLabelParts(writer: WriterRef, template = '{writer}'): LabelParts {
  const [outerBefore, outerAfter] = around(template, '{writer}')
  const kind = t(`authorship.kind.${writer.kind}`)
  const [innerBefore, innerAfter] = writer.name
    ? around(t('authorship.writerNamed'), '{name}').map((part) => format(part, { kind }))
    : [kind, '']
  return {
    before: `${outerBefore}${innerBefore}`,
    name: writer.name,
    after: `${innerAfter}${outerAfter}`,
    full: format(template, { writer: writerLabel(writer) }),
  }
}
