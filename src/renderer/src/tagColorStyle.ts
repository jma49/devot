import type { CSSProperties } from 'react'
import type { TagColorValue } from '../../core/storage'
import { isCustomTagColor, tagColorClass as classOf } from '../../core/tags'
import { tagInk } from './theme/tagInk'

const known = new Map<string, CSSProperties>()

/** The only colour values outside tokens: `.tag-color-custom` in app.css picks from them by appearance. */
export function tagColorStyle(color: TagColorValue | null | undefined): CSSProperties | undefined {
  if (!isCustomTagColor(color)) return undefined
  let style = known.get(color)
  if (!style) {
    const onLight = tagInk(color, 'light')
    const onDark = tagInk(color, 'dark')
    style = {
      '--tag-custom': color,
      '--tag-custom-text-light': onLight.text,
      '--tag-custom-text-dark': onDark.text,
      '--tag-custom-icon-light': onLight.icon,
      '--tag-custom-icon-dark': onDark.icon,
    } as CSSProperties
    known.set(color, style)
  }
  return style
}

export const tagColorClass = (color: TagColorValue | null | undefined) =>
  color ? classOf(color) : ''

/** A dot's class: one size and look, neutral for a tag with no colour. */
export const tagDotClass = (color: TagColorValue | null | undefined) =>
  color ? `tag-dot ${classOf(color)}` : 'tag-dot tag-dot-plain'
