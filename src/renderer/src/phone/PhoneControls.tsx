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
