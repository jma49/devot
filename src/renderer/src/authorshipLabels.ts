// How the UI names a writer (ADR 0007): the name a client gave, always with its kind, so a client
// can never pass for Edit with AI or the owner (risk 4). The HTTP API and Edit with AI have no name
// and show their kind alone. The clients Settings connects show by their product names; stored rows
// keep the raw name, so the mapping is made here, where old writes are shown too.
import type { WriterKind } from '../../core/authorship'
import { currentLocale, format, t } from './i18n'

export interface WriterRef {
  kind: WriterKind
  name: string
}

type Product = 'claudeCode' | 'claudeDesktop' | 'codex'

const PRODUCTS: ReadonlyMap<string, Product> = new Map([
  ['claude-code', 'claudeCode'],
  ['claude-ai', 'claudeDesktop'],
  ['local-agent-mode-devot', 'claudeDesktop'],
  ['codex-mcp-client', 'codex'],
])

const productOf = (writer: WriterRef): Product | undefined =>
  writer.kind === 'mcp' ? PRODUCTS.get(writer.name) : undefined

/** The writer's name as shown: a known client's product name, else the name it gave. */
export function writerName(writer: WriterRef): string {
  const product = productOf(writer)
  return product ? t(`integrations.${product}`) : writer.name
}

export function writerLabel(writer: WriterRef): string {
  const kind = t(`authorship.kind.${writer.kind}`)
  const name = writerName(writer)
  return name ? format(t('authorship.writerNamed'), { name, kind }) : kind
}

/**
 * One key per writer across sessions, as Undo All groups them: a product's names share one.
 * The separators differ, so a client that gives a product's name as its own never shares its key.
 */
export function writerKey(writer: WriterRef): string {
  const product = productOf(writer)
  return product ? `${writer.kind}#${product}` : `${writer.kind}:${writer.name}`
}

/** The writer as Undo All takes it: its kind and every name its product sends, so one Undo All takes them all. */
export function writerNames(writer: WriterRef): { kind: WriterKind; names: string[] } {
  const product = productOf(writer)
  const names = product
    ? [...PRODUCTS].filter(([, of]) => of === product).map(([name]) => name)
    : [writer.name]
  return { kind: writer.kind, names }
}

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
  const name = writerName(writer)
  const [innerBefore, innerAfter] = name
    ? around(t('authorship.writerNamed'), '{name}').map((part) => format(part, { kind }))
    : [kind, '']
  return {
    before: `${outerBefore}${innerBefore}`,
    name,
    after: `${innerAfter}${outerAfter}`,
    full: format(template, { writer: writerLabel(writer) }),
  }
}
