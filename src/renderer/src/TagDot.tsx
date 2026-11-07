import type { TagColorValue } from '../../core/storage'
import { isCustomTagColor } from '../../core/tags'
import { t } from './i18n'
import { tagColorStyle, tagDotClass } from './tagColorStyle'

/** A name with lower-case letters and no capitals, digits or caseless letters, whose dot centres on the x-height (design/layout.md, Capsules). */
export function lowercaseOnly(name: string): boolean {
  return /\p{Ll}/u.test(name) && !/[\p{Lu}\p{Lt}\p{Lo}\p{N}]/u.test(name)
}

export const dotCase = (name: string | undefined) =>
  name !== undefined && lowercaseOnly(name) ? '' : undefined

export function TagDot(props: { color: TagColorValue; name?: string }) {
  const { color } = props
  return (
    <span
      className={tagDotClass(color)}
      style={tagColorStyle(color)}
      data-color={color}
      data-lowercase={dotCase(props.name)}
      role="img"
      aria-label={isCustomTagColor(color) ? t('tagColor.custom') : t(`tagColor.${color}`)}
    />
  )
}
