import { writerLabelParts, type WriterRef } from './authorshipLabels'

/** A writer's label that, when it does not fit, cuts the name short and keeps the kind (ADR 0007, risk 4). */
export function WriterLabel(props: { writer: WriterRef; template?: string; className?: string }) {
  const parts = writerLabelParts(props.writer, props.template)
  return (
    <span
      className={`writer-label${props.className ? ` ${props.className}` : ''}`}
      title={parts.full}
    >
      {parts.before ? <span className="writer-label-fixed">{parts.before}</span> : null}
      {parts.name ? <span className="writer-label-name">{parts.name}</span> : null}
      {parts.after ? <span className="writer-label-fixed">{parts.after}</span> : null}
    </span>
  )
}
