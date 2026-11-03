import { TAG_COLORS, type TagColor, type TagColorValue } from '../../core/storage'
import { t } from './i18n'
import { TagDot } from './TagEditor'

export function ColorSwatches<V extends TagColorValue = TagColor>(props: {
  value: V | null
  onChange: (color: V | null) => void
  label: string
  noneLabel: string
}) {
  return (
    <div role="radiogroup" aria-label={props.label} className="tag-swatches">
      {[null, ...TAG_COLORS].map((option) => {
        const pick = option as V | null
        const name = option === null ? props.noneLabel : t(`tagColor.${option}`)
        return (
          <button
            key={option ?? 'none'}
            type="button"
            role="radio"
            className="tag-swatch"
            aria-checked={pick === props.value}
            aria-label={name}
            title={name}
            onClick={() => props.onChange(pick)}
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
