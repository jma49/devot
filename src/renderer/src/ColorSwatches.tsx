import { TAG_COLORS, type TagColor } from '../../core/storage'
import { t } from './i18n'
import { TagDot } from './TagEditor'

export function ColorSwatches(props: {
  value: TagColor | null
  onChange: (color: TagColor | null) => void
  label: string
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
