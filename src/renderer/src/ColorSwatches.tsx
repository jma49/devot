import { TAG_COLORS, type TagColor } from '../../core/storage'
import { t } from './i18n'
import { TagDot } from './TagEditor'

/** A row of the palette's colours, and none, to pick one from (a tag's, a notebook icon's). */
export function ColorSwatches(props: {
  value: TagColor | null
  onChange: (color: TagColor | null) => void
  /** The group's accessible name. */
  label: string
  /** The name of the option for no colour. */
  noneLabel: string
}) {
  return (
    <div role="radiogroup" aria-label={props.label} className="tag-swatches">
      {[null, ...TAG_COLORS].map((option) => {
        const name = option === null ? props.noneLabel : t(`tagColor.${option}`)
        return (
          <button
            key={option ?? 'none'}
            type="button"
            role="radio"
            className="tag-swatch"
            aria-checked={option === props.value}
            aria-label={name}
            title={name}
            onClick={() => props.onChange(option)}
          >
            {option === null ? (
              <span className="tag-swatch-none" aria-hidden="true" />
            ) : (
              <TagDot color={option} />
            )}
          </button>
        )
      })}
    </div>
  )
}
