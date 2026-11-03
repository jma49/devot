import { TAG_COLORS, type TagColor, type TagColorValue } from '../../core/storage'
import { isCustomTagColor } from '../../core/tags'
import { t } from './i18n'
import { Icon } from './icons/Icon'
import { TagDot } from './TagEditor'

export function ColorSwatches<V extends TagColorValue = TagColor>(props: {
  value: V | null
  onChange: (color: V | null) => void
  label: string
  noneLabel: string
  /** Adds a last swatch for a colour outside the palette. Tags have it; notebook icons do not. */
  onCustom?: () => void
}) {
  const custom = isCustomTagColor(props.value) ? props.value : null
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
      {props.onCustom ? (
        <button
          type="button"
          role="radio"
          className="tag-swatch"
          aria-checked={custom !== null}
          aria-label={t('tagColor.customPick')}
          aria-haspopup="dialog"
          title={t('tagColor.customPick')}
          onClick={props.onCustom}
        >
          <CustomSwatch color={custom} />
        </button>
      ) : null}
    </div>
  )
}

export function CustomSwatch(props: { color: TagColorValue | null }) {
  return props.color ? (
    <TagDot color={props.color} />
  ) : (
    <span className="tag-swatch-none tag-swatch-custom" aria-hidden="true">
      <Icon name="stepper.more" size="xs" />
    </span>
  )
}
