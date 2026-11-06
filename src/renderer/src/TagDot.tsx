import type { TagColorValue } from '../../core/storage'
import { isCustomTagColor } from '../../core/tags'
import { t } from './i18n'
import { tagColorStyle, tagDotClass } from './tagColorStyle'

export function TagDot(props: { color: TagColorValue }) {
  const { color } = props
  return (
    <span
      className={tagDotClass(color)}
      style={tagColorStyle(color)}
      data-color={color}
      role="img"
      aria-label={isCustomTagColor(color) ? t('tagColor.custom') : t(`tagColor.${color}`)}
    />
  )
}
