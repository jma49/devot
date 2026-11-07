// The notch of a floating bar: a small clipped box behind the bar holding two
// clipped layers, the glass edge as a band along the slanted sides and the
// material as a triangle shifted EDGE pixels in, so the edge shows as a thin
// outline. The box sits at the bar's edge, outside its rectangle, and paints
// over the bar's rim (a box-shadow, `floating.tsx`) where the two meet.
import { sizes } from '../theme/tokens'

export const NOTCH_WIDTH = Number.parseFloat(sizes['size.float-notch-width'])
export const NOTCH_HEIGHT = Number.parseFloat(sizes['size.float-notch-height'])
export const EDGE = 0.5

export const BAR_RADIUS = Number.parseFloat(sizes['radius.floating-bar'])
export const GLASS_BAR_RADIUS = Number.parseFloat(sizes['radius.glass-floating-bar'])
/**
 * How far the notch's tip is from the bar's left edge at rest, and the least it
 * is from either end: the notch's base (half its width each side of the tip)
 * stays on the straight part of the edge, clear of the rounded corners of
 * either interface's bar.
 */
export const NOTCH_X = Math.max(BAR_RADIUS, GLASS_BAR_RADIUS) + NOTCH_WIDTH / 2
export const BAR_GAP = NOTCH_HEIGHT

export const notchLeft = (tip: string, width: number) => `calc(${tip} - ${width / 2}px)`

const tip = `var(--float-notch-x, ${NOTCH_X}px)`
const half = NOTCH_WIDTH / 2
// Where the fill triangle's sides cross the edge triangle's base: the edge is clipped to the
// outline between the two, so the translucent material never shows the edge colour through it.
const inset = `${(half / NOTCH_HEIGHT) * EDGE}px`
const edge = 'var(--color-line-glass-edge)'
const tint = 'var(--glass-tint)'

export const notchStyles = {
  '.cm-float-notch': {
    position: 'absolute',
    zIndex: '-1',
    boxSizing: 'border-box',
    overflow: 'hidden',
    width: `${NOTCH_WIDTH}px`,
    height: `${NOTCH_HEIGHT}px`,
    left: notchLeft(tip, NOTCH_WIDTH),
    pointerEvents: 'none',
  },
  '.cm-tooltip-above > .cm-float-notch': { top: '100%' },
  '.cm-tooltip-below > .cm-float-notch': { bottom: '100%' },
  '.cm-float-notch::before, .cm-float-notch::after': {
    content: '""',
    position: 'absolute',
    left: '0',
    width: '100%',
    height: '100%',
  },
  // Pointing down (the bar is above its anchor): the edge band, then the material EDGE up.
  '.cm-tooltip-above > .cm-float-notch::before': {
    top: '0',
    background: edge,
    clipPath: `polygon(0 0, ${inset} 0, 50% calc(100% - ${EDGE}px), calc(100% - ${inset}) 0, 100% 0, 50% 100%)`,
  },
  '.cm-tooltip-above > .cm-float-notch::after': {
    top: `-${EDGE}px`,
    background: tint,
    clipPath: 'polygon(0 0, 100% 0, 50% 100%)',
  },
  // Pointing up, the notch meets the bar's top edge, where the sheen is at its strongest.
  '.cm-tooltip-below > .cm-float-notch::before': {
    bottom: '0',
    background: edge,
    clipPath: `polygon(0 100%, ${inset} 100%, 50% ${EDGE}px, calc(100% - ${inset}) 100%, 100% 100%, 50% 0)`,
  },
  '.cm-tooltip-below > .cm-float-notch::after': {
    bottom: `-${EDGE}px`,
    background: `var(--glass-sheen-top), ${tint}`,
    clipPath: 'polygon(0 100%, 100% 100%, 50% 0)',
  },
} satisfies Record<string, Record<string, string>>

export function notchElement(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'cm-float-notch'
  el.setAttribute('aria-hidden', 'true')
  return el
}
