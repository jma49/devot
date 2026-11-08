import { Icon } from '../icons/Icon'
import { figureParts } from './figures'

/** A message whose filled values take the figures style, its words staying in the body font. */
export function WithFigures(props: { template: string; values: Record<string, string> }) {
  return figureParts(props.template, props.values).map((part, index) =>
    part.figure ? (
      <span key={index} className="phone-figures">
        {part.text}
      </span>
    ) : (
      part.text
    ),
  )
}

export function SectionHead(props: {
  title: string
  count?: number
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <h2 className="phone-list-head-title">
      <button
        type="button"
        className="phone-list-head"
        aria-expanded={!props.collapsed}
        data-collapsed={props.collapsed || undefined}
        onClick={props.onToggle}
      >
        <span className="phone-list-head-name">{props.title}</span>
        {props.count !== undefined && (
          <span className="phone-list-head-count phone-figures">{props.count}</span>
        )}
        <span aria-hidden="true" className="phone-list-head-rule" />
        <span aria-hidden="true" className="phone-list-head-chevron">
          <Icon name="phone.section.chevron" size="sm" weight="medium" />
        </span>
      </button>
    </h2>
  )
}
