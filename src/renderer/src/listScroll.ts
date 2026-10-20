import { motionReduced } from './motionPreference'

/** A held key moves faster than a smooth scroll can follow. */
export const rowScrollBehavior = (reduced: boolean, repeating: boolean): ScrollBehavior =>
  reduced || repeating ? 'auto' : 'smooth'

export function scrollRowIntoView(row: Element, repeating: boolean): ScrollBehavior {
  const behavior = rowScrollBehavior(motionReduced(), repeating)
  row.scrollIntoView({ block: 'nearest', behavior })
  return behavior
}
